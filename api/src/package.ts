import semver, { type SemVer } from 'semver';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import cp from 'node:child_process';
import chownr from 'chownr';
import util from 'node:util';

import config from './config.ts';
import globals from './globals.ts';
import { create } from './logger.ts';
import { get_runtime_by_name_and_version, load_package } from './runtime.ts';
import { error_message } from './errors.ts';

const logger = create('package');

const chownr_async = util.promisify(chownr);

export interface PackageOptions {
    language: string;
    version: string;
    download: string;
    checksum: string;
}

/** The shape returned by install()/uninstall(), and by POST/DELETE /api/v2/packages. */
export interface PackageResult {
    language: string;
    version: string;
}

export default class Package {
    language: string;
    version: SemVer;
    checksum: string;
    download: string;

    constructor({ language, version, download, checksum }: PackageOptions) {
        const parsed = semver.parse(version);
        if (parsed === null) {
            throw new Error(
                `Package ${language} has an unparseable version: ${version}`
            );
        }
        this.language = language;
        this.version = parsed;
        this.checksum = checksum;
        this.download = download;
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

    async install(): Promise<PackageResult> {
        if (this.installed) {
            throw new Error('Already installed');
        }

        logger.info(`Installing ${this.language}-${this.version.raw}`);

        if (existsSync(this.install_path)) {
            logger.warn(
                `${this.language}-${this.version.raw} has residual files. Removing them.`
            );
            await fs.rm(this.install_path, { recursive: true, force: true });
        }

        logger.debug(`Making directory ${this.install_path}`);
        await fs.mkdir(this.install_path, { recursive: true });

        logger.debug(
            `Downloading package from ${this.download} in to ${this.install_path}`
        );
        const pkgpath = path.join(this.install_path, 'pkg.tar.gz');
        const download = await fetch(this.download);
        if (!download.ok) {
            throw new Error(
                `Failed to download package: ${download.status} ${download.statusText}`
            );
        }
        // Bun.write streams the response straight to disk without buffering it.
        await Bun.write(pkgpath, download);

        logger.debug('Validating checksums');
        logger.debug(`Assert sha256(pkg.tar.gz) == ${this.checksum}`);

        const hasher = new Bun.CryptoHasher('sha256');
        for await (const chunk of Bun.file(pkgpath).stream()) {
            hasher.update(chunk);
        }
        const cs = hasher.digest('hex');

        if (cs !== this.checksum) {
            throw new Error(
                `Checksum miss-match want: ${this.checksum} got: ${cs}`
            );
        }

        logger.debug(
            `Extracting package files from archive ${pkgpath} in to ${this.install_path}`
        );

        await new Promise<void>((resolve, reject) => {
            const proc = cp.exec(
                `bash -c 'cd "${this.install_path}" && tar xzf ${pkgpath}'`
            );

            proc.once('exit', code => {
                code === 0 ? resolve() : reject();
            });

            proc.stdout?.pipe(process.stdout);
            proc.stderr?.pipe(process.stderr);

            proc.once('error', reject);
        });

        logger.debug('Registering runtime');
        load_package(this.install_path);

        logger.debug('Caching environment');
        const get_env_command = `cd ${this.install_path}; source environment; env`;

        const envout = await new Promise<string>((resolve, reject) => {
            let stdout = '';

            const proc = cp.spawn(
                'env',
                ['-i', 'bash', '-c', `${get_env_command}`],
                {
                    stdio: ['ignore', 'pipe', 'pipe'],
                }
            );

            proc.once('exit', code => {
                code === 0 ? resolve(stdout) : reject();
            });

            proc.stdout.on('data', (data: Buffer) => {
                stdout += data;
            });

            proc.once('error', reject);
        });

        const filtered_env = envout
            .split('\n')
            .filter(
                l =>
                    !['PWD', 'OLDPWD', '_', 'SHLVL'].includes(
                        l.split('=', 2)[0] ?? ''
                    )
            )
            .join('\n');

        await fs.writeFile(path.join(this.install_path, '.env'), filtered_env);

        logger.debug('Changing Ownership of package directory');
        // getuid/getgid are POSIX-only and therefore optional in the type.
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid === undefined || gid === undefined) {
            throw new Error('Cannot determine uid/gid on this platform');
        }
        await chownr_async(this.install_path, uid, gid);

        logger.debug('Writing installed state to disk');
        await fs.writeFile(
            path.join(this.install_path, globals.pkg_installed_file),
            Date.now().toString()
        );

        logger.info(`Installed ${this.language}-${this.version.raw}`);

        return {
            language: this.language,
            version: this.version.raw,
        };
    }

    async uninstall(): Promise<PackageResult> {
        logger.info(`Uninstalling ${this.language}-${this.version.raw}`);

        logger.debug('Finding runtime');
        const found_runtime = get_runtime_by_name_and_version(
            this.language,
            this.version.raw
        );

        if (!found_runtime) {
            logger.error(
                `Uninstalling ${this.language}-${this.version.raw} failed: Not installed`
            );
            throw new Error(
                `${this.language}-${this.version.raw} is not installed`
            );
        }

        logger.debug('Unregistering runtime');
        found_runtime.unregister();

        logger.debug('Cleaning files from disk');
        await fs.rm(this.install_path, { recursive: true, force: true });

        logger.info(`Uninstalled ${this.language}-${this.version.raw}`);

        return {
            language: this.language,
            version: this.version.raw,
        };
    }

    static async get_package_list(): Promise<Package[]> {
        const response = await fetch(config.repo_url);
        const repo_content = await response.text();

        const entries = repo_content.split('\n').filter(x => x.length > 0);

        return entries.flatMap(line => {
            const [language, version, checksum, download] = line.split(',', 4);
            if (!language || !version || !checksum || !download) {
                logger.warn(`Skipping malformed package index line: ${line}`);
                return [];
            }

            try {
                return [new Package({ language, version, checksum, download })];
            } catch (e) {
                logger.warn(
                    `Skipping unparseable package index line: ${line}`,
                    error_message(e)
                );
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
            return (
                pkg.language == lang && semver.satisfies(pkg.version, version)
            );
        });

        candidates.sort((a, b) => semver.rcompare(a.version, b.version));

        return candidates[0] || null;
    }
}
