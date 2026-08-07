import semver, { type SemVer } from 'semver';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import cp from 'node:child_process';
import chownr from 'chownr';
import util from 'node:util';
import os from 'node:os';

import config from './config.ts';
import globals from './globals.ts';
import { create } from './logger.ts';
import { runtimes, load_package } from './runtime.ts';
import { error_message } from './errors.ts';
import {
    is_engine_installable,
    render_build,
    load_manifests,
    render_env,
    render_pkg_info,
    render_stage,
    type Manifest,
    type ManifestSource,
} from './manifest.ts';

const logger = create('package');

const chownr_async = util.promisify(chownr);

/** The shape returned by install()/uninstall(), and by POST/DELETE /api/v2/packages. */
export interface PackageResult {
    language: string;
    version: string;
}

/** Where install progress goes. Operations wire this to a log the client can read. */
export type InstallLog = (line: string) => void;

const noop_log: InstallLog = () => {};

/**
 * Every manifest the image ships. This is the whitelist: a language with no
 * manifest cannot be installed by any request, however it is spelled.
 */
let manifests: Manifest[] = [];

export async function load_all_manifests(): Promise<number> {
    manifests = await load_manifests(config.manifest_directory);
    return manifests.length;
}

/** Whether an operator has allowed this language through PISTON_ALLOWED_LANGUAGES. */
function language_allowed(language: string): boolean {
    return config.allowed_languages.some(pattern =>
        new Bun.Glob(pattern).match(language)
    );
}

/** `tar` flags per archive format. zip is handled separately - it is not tar. */
const TAR_FLAGS: Record<string, string[]> = {
    'tar.gz': ['-xzf'],
    'tar.xz': ['-xJf'],
    'tar.bz2': ['-xjf'],
    'tar.zst': ['--zstd', '-xf'],
    tar: ['-xf'],
};

/** Runs a command with no shell, so nothing in a manifest can be injected. */
function run(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(command, args, {
            cwd: options.cwd,
            ...(options.env ? { env: options.env } : {}),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data: Buffer) => (stdout += data));
        proc.stderr.on('data', (data: Buffer) => (stderr += data));

        proc.once('error', reject);
        proc.once('close', code =>
            resolve({ code: code ?? -1, stdout, stderr })
        );
    });
}

export default class Package {
    manifest: Manifest;
    version: SemVer;

    constructor(manifest: Manifest) {
        const parsed = semver.parse(manifest.version);
        if (parsed === null) {
            throw new Error(
                `Package ${manifest.language} has an unparseable version: ${manifest.version}`
            );
        }
        this.manifest = manifest;
        this.version = parsed;
    }

    get language(): string {
        return this.manifest.language;
    }

    get installed(): boolean {
        return existsSync(
            path.join(this.install_path, globals.pkg_installed_file)
        );
    }

    get install_path(): string {
        return path.join(
            config.data_directory,
            globals.data_directories.packages,
            this.language,
            this.version.raw
        );
    }

    /**
     * Looks up the archive CI published for this package.
     *
     * The index is still `language,version,sha256,url` per line - it is only
     * consulted for packages that need a source build now, but the checksum in
     * it is the only thing that makes that archive trustworthy, so it must come
     * from the index rather than be derived from a URL pattern.
     */
    async #prebuilt_entry(): Promise<{ url: string; sha256: string }> {
        const response = await fetch(config.repo_url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch the package index: ${response.status} ${response.statusText}`
            );
        }

        for (const line of (await response.text()).split('\n')) {
            const [language, version, sha256, url] = line.split(',', 4);
            if (
                language === this.language &&
                version === this.version.raw &&
                sha256 &&
                url
            ) {
                return { url, sha256 };
            }
        }

        throw new Error(
            `${this.language}-${this.version.raw} must be built from source, ` +
                `and no prebuilt archive is published for it`
        );
    }

    /**
     * Streams a source to disk, hashing as it goes, and refuses anything whose
     * digest does not match the manifest.
     *
     * Deliberately not `Bun.write(path, response)`: on Bun 1.3.14 that form
     * hangs indefinitely on a large body, which silently wedged every install
     * of a package bigger than a few megabytes.
     */
    async #fetch_source(
        source: ManifestSource,
        destination: string,
        log: InstallLog
    ): Promise<void> {
        log(`Fetching ${source.url}`);

        const response = await fetch(source.url);
        if (!response.ok) {
            throw new Error(
                `Failed to download package: ${response.status} ${response.statusText}`
            );
        }
        if (!response.body) {
            throw new Error('Failed to download package: empty response');
        }

        const hasher = new Bun.CryptoHasher('sha256');
        const sink = Bun.file(destination).writer();
        let bytes = 0;

        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            hasher.update(chunk);
            sink.write(chunk);
            bytes += chunk.length;
        }
        await sink.end();

        const digest = hasher.digest('hex');
        if (digest !== source.sha256) {
            throw new Error(
                `Checksum miss-match want: ${source.sha256} got: ${digest}`
            );
        }

        log(`Fetched ${bytes} bytes, sha256 ok`);
    }

    async #extract(
        source: ManifestSource,
        archive: string,
        log: InstallLog
    ): Promise<void> {
        const into = source.into
            ? path.join(this.install_path, source.into)
            : this.install_path;
        await fs.mkdir(into, { recursive: true });

        log(`Extracting into ${path.relative(this.install_path, into) || '.'}`);

        if (source.format === 'zip') {
            // unzip has no --strip-components, so it is done by hand rather
            // than silently ignored: `strip` has to mean the same thing for
            // every format, or a manifest cannot be written from the URL alone.
            const target = source.strip
                ? path.join(this.install_path, '.unzip')
                : into;
            await fs.mkdir(target, { recursive: true });

            const result = await run('unzip', [
                '-q',
                '-o',
                archive,
                '-d',
                target,
            ]);
            if (result.code !== 0) {
                throw new Error(
                    `Failed to extract archive: ${result.stderr.trim()}`
                );
            }

            if (source.strip) {
                let inner = target;
                for (let level = 0; level < source.strip; level++) {
                    const entries = await fs.readdir(inner);
                    const only = entries[0];
                    if (entries.length !== 1 || only === undefined) {
                        throw new Error(
                            `Cannot strip ${source.strip} level(s): ` +
                                `${inner} holds ${entries.length} entries`
                        );
                    }
                    inner = path.join(inner, only);
                }
                for (const entry of await fs.readdir(inner)) {
                    await fs.rename(
                        path.join(inner, entry),
                        path.join(into, entry)
                    );
                }
                await fs.rm(target, { recursive: true, force: true });
            }
            return;
        }

        const flags = TAR_FLAGS[source.format];
        if (!flags) {
            throw new Error(`Unsupported archive format: ${source.format}`);
        }

        const result = await run('tar', [
            ...flags,
            archive,
            '-C',
            into,
            ...(source.strip ? [`--strip-components=${source.strip}`] : []),
        ]);
        if (result.code !== 0) {
            throw new Error(
                `Failed to extract archive: ${result.stderr.trim()}`
            );
        }
    }

    /**
     * Renders the manifest into the layout every other module expects:
     * pkg-info.json, .env, run and (when the manifest has one) compile. Nothing
     * downstream knows manifests exist.
     */
    async #write_package_files(log: InstallLog): Promise<void> {
        const { manifest } = this;

        log('Writing package files');

        await Bun.write(
            path.join(this.install_path, 'pkg-info.json'),
            render_pkg_info(manifest, globals.platform)
        );

        await Bun.write(
            path.join(this.install_path, 'run'),
            render_stage(manifest.run)
        );

        if (manifest.compile !== undefined) {
            await Bun.write(
                path.join(this.install_path, 'compile'),
                render_stage(manifest.compile)
            );
        }

        // The declarative map covers all but a couple of packages. The escape
        // hatch exists for the ones that compute a value at install time, and
        // its output wins so it can override what the map set.
        let extra: Record<string, string> = {};
        if (manifest.env_script !== undefined) {
            log('Evaluating env_script');
            extra = await this.#evaluate_env_script(manifest.env_script);
        }

        await Bun.write(
            path.join(this.install_path, '.env'),
            render_env(manifest, this.install_path, extra)
        );
    }

    async #evaluate_env_script(
        script: string
    ): Promise<Record<string, string>> {
        const script_path = path.join(this.install_path, '.env_script');
        await Bun.write(script_path, render_stage(script));

        // `env -i` so the result depends only on the script, exactly as the old
        // `environment` file was evaluated.
        const result = await run('env', [
            '-i',
            'bash',
            '-c',
            `cd "${this.install_path}" && source .env_script && env`,
        ]);
        await fs.rm(script_path, { force: true });

        if (result.code !== 0) {
            throw new Error(`env_script failed: ${result.stderr.trim()}`);
        }

        const env: Record<string, string> = {};
        for (const line of result.stdout.split('\n')) {
            const at = line.indexOf('=');
            if (at <= 0) continue;
            const key = line.slice(0, at);
            if (['PWD', 'OLDPWD', '_', 'SHLVL'].includes(key)) continue;
            env[key] = line.slice(at + 1);
        }
        return env;
    }

    async install(log: InstallLog = noop_log): Promise<PackageResult> {
        // Tee everything to <install_path>/.install.log as well as to the
        // caller. A synchronous install has nowhere else to put build output,
        // and the log has to outlive a failure to be worth anything.
        const transcript: string[] = [];
        const tee: InstallLog = line => {
            transcript.push(line);
            log(line);
        };

        try {
            return await this.#install(tee);
        } finally {
            if (transcript.length > 0 && existsSync(this.install_path)) {
                await fs
                    .writeFile(
                        path.join(this.install_path, '.install.log'),
                        transcript.join('\n') + '\n'
                    )
                    .catch(() => {
                        /* a log we cannot write must not fail the install */
                    });
            }
        }
    }

    async #install(log: InstallLog): Promise<PackageResult> {
        if (this.installed) {
            throw new Error('Already installed');
        }

        if (!language_allowed(this.language)) {
            throw new Error(
                `Language ${this.language} is not allowed by this instance`
            );
        }

        logger.info(`Installing ${this.language}-${this.version.raw}`);
        log(`Installing ${this.language}-${this.version.raw}`);

        if (existsSync(this.install_path)) {
            logger.warn(
                `${this.language}-${this.version.raw} has residual files. Removing them.`
            );
            await fs.rm(this.install_path, { recursive: true, force: true });
        }
        await fs.mkdir(this.install_path, { recursive: true });

        const archives: string[] = [];

        try {
            if (is_engine_installable(this.manifest)) {
                for (const [i, source] of this.manifest.sources.entries()) {
                    const archive = path.join(
                        this.install_path,
                        `.source-${i}`
                    );
                    archives.push(archive);
                    await this.#fetch_source(source, archive, log);
                    await this.#extract(source, archive, log);
                }
            } else if (config.allow_source_builds) {
                await this.#build_from_source(log);
            } else {
                // The package needs a toolchain this image does not have, so it
                // is served as a prebuilt archive that CI produced from the very
                // same manifest.
                const archive = path.join(
                    this.install_path,
                    '.source-prebuilt'
                );
                archives.push(archive);
                await this.#fetch_prebuilt(archive, log);
            }

            await this.#write_package_files(log);

            log('Registering runtime');
            load_package(this.install_path);

            const uid = process.getuid?.();
            const gid = process.getgid?.();
            if (uid === undefined || gid === undefined) {
                throw new Error('Cannot determine uid/gid on this platform');
            }
            await chownr_async(this.install_path, uid, gid);

            await fs.writeFile(
                path.join(this.install_path, globals.pkg_installed_file),
                Date.now().toString()
            );
        } finally {
            // Downloaded archives are never part of the installed package.
            // The old code left a pkg.tar.gz behind on every install.
            for (const archive of archives) {
                await fs.rm(archive, { force: true });
            }
        }

        logger.info(`Installed ${this.language}-${this.version.raw}`);
        log(`Installed ${this.language}-${this.version.raw}`);

        return { language: this.language, version: this.version.raw };
    }

    /** Fetches and verifies the archive CI built from this manifest's `build` script. */
    async #fetch_prebuilt(archive: string, log: InstallLog): Promise<void> {
        const entry = await this.#prebuilt_entry();

        // Reuses the source fetcher so the archive is checksum-verified on the
        // same path an upstream source is.
        await this.#fetch_source(
            {
                url: entry.url,
                sha256: entry.sha256,
                strip: 0,
                format: 'tar.gz',
            },
            archive,
            log
        );

        const result = await run('tar', [
            '-xzf',
            archive,
            '-C',
            this.install_path,
        ]);
        if (result.code !== 0) {
            throw new Error(
                `Failed to extract archive: ${result.stderr.trim()}`
            );
        }
    }

    /**
     * Runs the manifest's build script in the package directory. Only reachable
     * on the builder image, which is the one that ships a toolchain.
     */
    async #build_from_source(log: InstallLog): Promise<void> {
        const { manifest } = this;

        for (const [i, source] of manifest.sources.entries()) {
            const archive = path.join(this.install_path, `.source-${i}`);
            await this.#fetch_source(source, archive, log);
            await this.#extract(source, archive, log);
            await fs.rm(archive, { force: true });
        }

        for (const [name, script] of [
            ['build', manifest.build],
            ['post_install', manifest.post_install],
        ] as const) {
            if (script === undefined) continue;

            log(`Running ${name}`);
            const script_path = path.join(this.install_path, `.${name}`);
            await Bun.write(script_path, render_build(script));

            // npm, pip and cargo all want a writable HOME, and the API inherits
            // HOME=/root from the entrypoint's su, which it cannot write to.
            // Point at the piston user's own home - the image creates it, and
            // tools that ignore $HOME in favour of getpwuid (the JVM, hence
            // Maven's ~/.m2) land in the same place rather than a second one.
            const home = os.homedir();

            const result = await run('bash', [script_path], {
                cwd: this.install_path,
                env: {
                    ...(process.env as Record<string, string>),
                    PREFIX: this.install_path,
                    HOME: home,
                },
            });
            await fs.rm(script_path, { force: true });

            if (result.stdout.trim()) log(result.stdout.trim());
            if (result.stderr.trim()) log(result.stderr.trim());

            if (result.code !== 0) {
                // A synchronous install reports only this message, so carry the
                // tail of the output in it. Without that a failed build is just
                // "exit code 1" and the reason is nowhere.
                const lines = [result.stdout, result.stderr]
                    .join('\n')
                    .split('\n')
                    .map(line => line.trim())
                    // curl's progress meter is redrawn continuously and would
                    // otherwise be the entire tail, hiding the actual error.
                    .filter(
                        line =>
                            line.length > 0 &&
                            !/^\d+\s+[\d.]+[KMG]?\s/.test(line) &&
                            !line.startsWith('% Total') &&
                            !line.startsWith('Dload')
                    );

                // Prefer lines that look like the failure over the last thing
                // printed, which is often unrelated cleanup.
                const interesting = lines.filter(line =>
                    /error|failed|fatal|cannot|not found|no such|denied/i.test(
                        line
                    )
                );
                const tail = (interesting.length ? interesting : lines)
                    .slice(-8)
                    .join(' | ');
                throw new Error(
                    `${name} failed with exit code ${result.code}` +
                        (tail ? `: ${tail}` : '')
                );
            }
        }
    }

    async uninstall(): Promise<PackageResult> {
        logger.info(`Uninstalling ${this.language}-${this.version.raw}`);

        // Every runtime this package registered, not just the first. A package
        // with `provides` registers one per provided language, and unregistering
        // only one of them used to leave the rest live against a deleted tree.
        const registered = runtimes.filter(
            rt =>
                rt.pkgdir === this.install_path &&
                rt.version.raw === this.version.raw
        );

        if (registered.length === 0) {
            logger.error(
                `Uninstalling ${this.language}-${this.version.raw} failed: Not installed`
            );
            throw new Error(
                `${this.language}-${this.version.raw} is not installed`
            );
        }

        for (const runtime of registered) runtime.unregister();

        await fs.rm(this.install_path, { recursive: true, force: true });

        logger.info(`Uninstalled ${this.language}-${this.version.raw}`);

        return { language: this.language, version: this.version.raw };
    }

    static async get_package_list(): Promise<Package[]> {
        return manifests
            .filter(m => language_allowed(m.language))
            .flatMap(m => {
                try {
                    return [new Package(m)];
                } catch (e) {
                    logger.warn(`Skipping ${m.origin}`, error_message(e));
                    return [];
                }
            });
    }

    static async get_package(
        lang: string,
        version: string
    ): Promise<Package | null> {
        const packages = await Package.get_package_list();

        const candidates = packages.filter(pkg => {
            try {
                return (
                    pkg.language === lang &&
                    semver.satisfies(pkg.version, version)
                );
            } catch {
                // An unparseable range is "no match", not a 500.
                return false;
            }
        });

        candidates.sort((a, b) => semver.rcompare(a.version, b.version));

        return candidates[0] || null;
    }
}
