/**
 * The package manifest: one YAML file per language version, holding everything
 * the old `packages/<lang>/<version>/` directory held across six files.
 *
 * A manifest is an *authoring and distribution* format. Installing one renders
 * it into the same on-disk layout packages have always had - `pkg-info.json`,
 * `.env`, `run`, `compile` - so `runtime.ts` and `job.ts` keep reading exactly
 * the files they read before, and know nothing about manifests.
 */

import semver from 'semver';
import path from 'node:path';
import fs from 'node:fs/promises';

import type { LanguageLimits } from './config.ts';

/**
 * PATH used when a manifest writes `{PATH}`.
 *
 * This is bash's own compiled-in default minus the trailing `.`, which is what
 * the old `env -i bash -c 'source environment; env'` scheme produced. Keeping
 * the current directory on PATH inside a sandbox running attacker-controlled
 * code lets a submitted file shadow a system binary, so it is dropped.
 */
export const DEFAULT_PATH =
    '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin';

/** Archive formats the installer can extract, keyed by the suffix that implies them. */
const ARCHIVE_FORMATS = {
    '.tar.gz': 'tar.gz',
    '.tgz': 'tar.gz',
    '.tar.xz': 'tar.xz',
    '.txz': 'tar.xz',
    '.tar.bz2': 'tar.bz2',
    '.tbz2': 'tar.bz2',
    '.tar.zst': 'tar.zst',
    '.tar': 'tar',
    '.zip': 'zip',
} as const;

export type ArchiveFormat =
    (typeof ARCHIVE_FORMATS)[keyof typeof ARCHIVE_FORMATS];

const ARCHIVE_FORMAT_VALUES = [
    ...new Set(Object.values(ARCHIVE_FORMATS)),
] as readonly ArchiveFormat[];

export interface ManifestSource {
    url: string;
    /** Mandatory. The hash is the artifact's identity; an unpinned source is never installed. */
    sha256: string;
    /** tar --strip-components. Defaults to 0. */
    strip: number;
    /** Extract into this subdirectory of the package instead of its root. */
    into?: string;
    /** Inferred from the url when the manifest does not say. */
    format: ArchiveFormat;
}

export interface ManifestProvides {
    language: string;
    aliases?: string[];
    limit_overrides?: LanguageLimits;
}

export interface ManifestTest {
    /** Substring the run stage's output must contain. */
    expect: string;
    source: string;
    /** Which provided language to run the test as. Defaults to the manifest's language. */
    language?: string;
}

export interface Manifest {
    language: string;
    version: string;
    aliases?: string[];
    provides?: ManifestProvides[];
    limit_overrides?: LanguageLimits;

    /** Where the runtime comes from. Empty only for packages built purely by `build`. */
    sources: ManifestSource[];
    /** Shell run in a builder to produce the package. Requires the build path. */
    build?: string;
    /** Shell run after sources are extracted. Requires the build path. */
    post_install?: string;
    /**
     * Declared glibc floor of the prebuilt binaries, asserted against the base
     * image in CI. `none` means statically linked - a real answer, not a
     * missing one, so the validator can still insist the field is present.
     */
    glibc?: string;

    /** Rendered directly into `.env`. `{pkgdir}` and `{PATH}` are substituted. */
    env: Record<string, string>;
    /**
     * Escape hatch for the one package that computes an env value at install
     * time (dotnet's `FSI_PATH=$(find ...)`). Sourced like the old
     * `environment` file, and merged over `env`.
     */
    env_script?: string;

    /** Presence decides `Runtime.compiled`, exactly as the `compile` file did. */
    compile?: string;
    run: string;

    test?: ManifestTest;

    /** Absolute path this manifest was read from. Not part of the file. */
    origin: string;
}

export class ManifestError extends Error {
    constructor(origin: string, message: string) {
        super(`${origin}: ${message}`);
        this.name = 'ManifestError';
    }
}

// ------------------------------------------------------------------ checking

function is_record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function require_string(origin: string, where: string, value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new ManifestError(origin, `${where} must be a non-empty string`);
    }
    return value;
}

function optional_string(
    origin: string,
    where: string,
    value: unknown
): string | undefined {
    if (value === undefined) return undefined;
    return require_string(origin, where, value);
}

function optional_string_array(
    origin: string,
    where: string,
    value: unknown
): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new ManifestError(origin, `${where} must be a list of strings`);
    }
    return value.map((entry, i) =>
        require_string(origin, `${where}[${i}]`, entry)
    );
}

const LIMIT_KEYS = [
    'max_process_count',
    'max_open_files',
    'max_file_size',
    'compile_memory_limit',
    'run_memory_limit',
    'compile_timeout',
    'run_timeout',
    'compile_cpu_time',
    'run_cpu_time',
    'output_max_size',
] as const satisfies readonly (keyof LanguageLimits)[];

function optional_limits(
    origin: string,
    where: string,
    value: unknown
): LanguageLimits | undefined {
    if (value === undefined) return undefined;
    if (!is_record(value)) {
        throw new ManifestError(origin, `${where} must be a mapping`);
    }

    const limits: LanguageLimits = {};
    for (const [key, raw] of Object.entries(value)) {
        if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
            throw new ManifestError(
                origin,
                `${where}.${key} is not an overridable limit`
            );
        }
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            throw new ManifestError(origin, `${where}.${key} must be a number`);
        }
        limits[key as keyof LanguageLimits] = raw;
    }
    return limits;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function infer_format(origin: string, url: string): ArchiveFormat {
    // Longest suffix first, so `.tar.gz` wins over `.gz`-style prefixes of it.
    const suffixes = Object.keys(ARCHIVE_FORMATS).sort(
        (a, b) => b.length - a.length
    );
    const pathname = (() => {
        try {
            return new URL(url).pathname;
        } catch {
            throw new ManifestError(origin, `sources url is not a url: ${url}`);
        }
    })();

    for (const suffix of suffixes) {
        if (pathname.endsWith(suffix)) {
            return ARCHIVE_FORMATS[suffix as keyof typeof ARCHIVE_FORMATS];
        }
    }
    throw new ManifestError(
        origin,
        `cannot infer an archive format from ${url}; set sources[].format`
    );
}

function parse_source(
    origin: string,
    where: string,
    value: unknown
): ManifestSource {
    if (!is_record(value)) {
        throw new ManifestError(origin, `${where} must be a mapping`);
    }

    const url = require_string(origin, `${where}.url`, value.url);

    const sha256 = require_string(origin, `${where}.sha256`, value.sha256);
    if (!SHA256_RE.test(sha256)) {
        throw new ManifestError(
            origin,
            `${where}.sha256 must be 64 lowercase hex characters`
        );
    }

    if (value.strip !== undefined && typeof value.strip !== 'number') {
        throw new ManifestError(origin, `${where}.strip must be a number`);
    }
    const strip = value.strip ?? 0;
    if (!Number.isInteger(strip) || strip < 0) {
        throw new ManifestError(
            origin,
            `${where}.strip must be a non-negative integer`
        );
    }

    const into = optional_string(origin, `${where}.into`, value.into);
    if (
        into !== undefined &&
        (path.isAbsolute(into) || into.split('/').includes('..'))
    ) {
        throw new ManifestError(
            origin,
            `${where}.into must be a relative path inside the package`
        );
    }

    const declared = optional_string(origin, `${where}.format`, value.format);
    if (
        declared !== undefined &&
        !(ARCHIVE_FORMAT_VALUES as readonly string[]).includes(declared)
    ) {
        throw new ManifestError(
            origin,
            `${where}.format must be one of ${ARCHIVE_FORMAT_VALUES.join(', ')}`
        );
    }

    return {
        url,
        sha256,
        strip,
        ...(into === undefined ? {} : { into }),
        format:
            (declared as ArchiveFormat | undefined) ??
            infer_format(origin, url),
    };
}

const KNOWN_KEYS = new Set([
    'language',
    'version',
    'aliases',
    'provides',
    'limit_overrides',
    'sources',
    'build',
    'post_install',
    'glibc',
    'env',
    'env_script',
    'compile',
    'run',
    'test',
]);

/** Parses and fully validates one manifest. Throws ManifestError on anything wrong. */
export function parse_manifest(text: string, origin: string): Manifest {
    let doc: unknown;
    try {
        doc = Bun.YAML.parse(text);
    } catch (e) {
        throw new ManifestError(
            origin,
            `not valid YAML: ${e instanceof Error ? e.message : String(e)}`
        );
    }

    if (!is_record(doc)) {
        throw new ManifestError(origin, 'must be a mapping at the top level');
    }

    for (const key of Object.keys(doc)) {
        if (!KNOWN_KEYS.has(key)) {
            throw new ManifestError(origin, `unknown key: ${key}`);
        }
    }

    const language = require_string(origin, 'language', doc.language);
    const version = require_string(origin, 'version', doc.version);
    if (semver.parse(version) === null) {
        throw new ManifestError(origin, `version is not semver: ${version}`);
    }

    let provides: ManifestProvides[] | undefined;
    if (doc.provides !== undefined) {
        if (!Array.isArray(doc.provides) || doc.provides.length === 0) {
            throw new ManifestError(
                origin,
                'provides must be a non-empty list'
            );
        }
        provides = doc.provides.map((entry, i) => {
            if (!is_record(entry)) {
                throw new ManifestError(
                    origin,
                    `provides[${i}] must be a mapping`
                );
            }
            const provided: ManifestProvides = {
                language: require_string(
                    origin,
                    `provides[${i}].language`,
                    entry.language
                ),
            };
            const aliases = optional_string_array(
                origin,
                `provides[${i}].aliases`,
                entry.aliases
            );
            if (aliases) provided.aliases = aliases;
            const limits = optional_limits(
                origin,
                `provides[${i}].limit_overrides`,
                entry.limit_overrides
            );
            if (limits) provided.limit_overrides = limits;
            return provided;
        });
    }

    if (doc.sources !== undefined && !Array.isArray(doc.sources)) {
        throw new ManifestError(origin, 'sources must be a list');
    }
    const sources = (doc.sources ?? []).map((entry, i) =>
        parse_source(origin, `sources[${i}]`, entry)
    );

    const build = optional_string(origin, 'build', doc.build);
    const post_install = optional_string(
        origin,
        'post_install',
        doc.post_install
    );

    if (sources.length === 0 && build === undefined) {
        throw new ManifestError(
            origin,
            'needs at least one source or a build script'
        );
    }

    let env: Record<string, string> = {};
    if (doc.env !== undefined) {
        if (!is_record(doc.env)) {
            throw new ManifestError(origin, 'env must be a mapping');
        }
        env = Object.fromEntries(
            Object.entries(doc.env).map(([key, value]) => [
                key,
                require_string(origin, `env.${key}`, value),
            ])
        );
    }

    let test: ManifestTest | undefined;
    if (doc.test !== undefined) {
        if (!is_record(doc.test)) {
            throw new ManifestError(origin, 'test must be a mapping');
        }
        test = {
            expect:
                optional_string(origin, 'test.expect', doc.test.expect) ?? 'OK',
            source: require_string(origin, 'test.source', doc.test.source),
        };
        const test_language = optional_string(
            origin,
            'test.language',
            doc.test.language
        );
        if (test_language) test.language = test_language;
    }

    const manifest: Manifest = {
        language,
        version,
        sources,
        env,
        run: require_string(origin, 'run', doc.run),
        origin,
    };

    const aliases = optional_string_array(origin, 'aliases', doc.aliases);
    if (aliases) manifest.aliases = aliases;
    if (provides) manifest.provides = provides;

    const limits = optional_limits(
        origin,
        'limit_overrides',
        doc.limit_overrides
    );
    if (limits) manifest.limit_overrides = limits;

    if (build !== undefined) manifest.build = build;
    if (post_install !== undefined) manifest.post_install = post_install;

    const glibc = optional_string(origin, 'glibc', doc.glibc);
    if (glibc !== undefined) manifest.glibc = glibc;

    const env_script = optional_string(origin, 'env_script', doc.env_script);
    if (env_script !== undefined) manifest.env_script = env_script;

    const compile = optional_string(origin, 'compile', doc.compile);
    if (compile !== undefined) manifest.compile = compile;

    if (test) manifest.test = test;

    if (provides && aliases) {
        throw new ManifestError(
            origin,
            'aliases belongs on each provides entry when provides is used'
        );
    }

    return manifest;
}

/**
 * Whether the engine can install this manifest on its own: fetch, verify,
 * extract, write the wrappers. Anything needing a shell build has to go through
 * a builder - CI, or the builder image with PISTON_ALLOW_SOURCE_BUILDS set.
 */
export function is_engine_installable(manifest: Manifest): boolean {
    return (
        manifest.sources.length > 0 &&
        manifest.build === undefined &&
        manifest.post_install === undefined
    );
}

/** Every language this package registers - itself, or each of its `provides`. */
export function provided_languages(manifest: Manifest): string[] {
    return manifest.provides
        ? manifest.provides.map(p => p.language)
        : [manifest.language];
}

// ----------------------------------------------------------------- rendering

/** Expands `{pkgdir}` and `{PATH}`. Unknown `{...}` is left alone. */
export function expand_tokens(value: string, pkgdir: string): string {
    return value
        .replaceAll('{pkgdir}', pkgdir)
        .replaceAll('{PATH}', DEFAULT_PATH);
}

/**
 * The `.env` body. One `KEY=value` per line, matching what the old
 * `env -i bash -c 'source environment; env'` scheme wrote, because
 * `Runtime.env_vars` splits this file on newlines.
 */
export function render_env(
    manifest: Manifest,
    pkgdir: string,
    extra: Record<string, string> = {}
): string {
    const merged = { ...manifest.env, ...extra };
    return Object.entries(merged)
        .map(([key, value]) => `${key}=${expand_tokens(value, pkgdir)}`)
        .join('\n');
}

/** The `pkg-info.json` body - the only package file `runtime.ts` reads. */
export function render_pkg_info(
    manifest: Manifest,
    build_platform: string
): string {
    const info: Record<string, unknown> = {
        language: manifest.language,
        version: manifest.version,
        build_platform,
    };
    if (manifest.aliases) info.aliases = manifest.aliases;
    if (manifest.provides) info.provides = manifest.provides;
    if (manifest.limit_overrides) {
        info.limit_overrides = manifest.limit_overrides;
    }
    return JSON.stringify(info, null, 4);
}

/** A stage script, given the shebang the old hand-written files carried. */
export function render_stage(body: string): string {
    return `#!/usr/bin/env bash\n\n${body.endsWith('\n') ? body : body + '\n'}`;
}

// ------------------------------------------------------------------ loading

/** `<dir>/<language>/<version>.yaml` */
export function manifest_path(
    dir: string,
    language: string,
    version: string
): string {
    return path.join(dir, language, `${version}.yaml`);
}

export async function load_manifest(file: string): Promise<Manifest> {
    return parse_manifest(await Bun.file(file).text(), file);
}

/**
 * Reads every `<dir>/<language>/<version>.yaml`. Rejects a manifest whose
 * language and version disagree with its own path, so the filesystem layout
 * stays the index.
 */
export async function load_manifests(dir: string): Promise<Manifest[]> {
    const languages = await fs.readdir(dir, { withFileTypes: true });

    const manifests = await Promise.all(
        languages
            .filter(entry => entry.isDirectory())
            .map(async entry => {
                const language_dir = path.join(dir, entry.name);
                const files = await fs.readdir(language_dir);

                return Promise.all(
                    files
                        .filter(file => file.endsWith('.yaml'))
                        .map(async file => {
                            const full = path.join(language_dir, file);
                            const manifest = await load_manifest(full);
                            const version = file.slice(0, -'.yaml'.length);

                            if (manifest.language !== entry.name) {
                                throw new ManifestError(
                                    full,
                                    `language is ${manifest.language} but the directory is ${entry.name}`
                                );
                            }
                            if (manifest.version !== version) {
                                throw new ManifestError(
                                    full,
                                    `version is ${manifest.version} but the filename is ${version}`
                                );
                            }
                            return manifest;
                        })
                );
            })
    );

    return manifests.flat();
}
