import semver, { type SemVer } from 'semver';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import config, { type LanguageLimits } from './config.ts';
import globals from './globals.ts';
import { create } from './logger.ts';

const logger = create('runtime');

/** Limits that differ between the compile and run stages. */
export interface StageLimits {
    compile: number;
    run: number;
}

/** The fully-resolved limit set for one runtime. */
export interface ComputedLimits {
    timeouts: StageLimits;
    cpu_times: StageLimits;
    memory_limits: StageLimits;
    max_process_count: number;
    max_open_files: number;
    max_file_size: number;
    output_max_size: number;
}

export interface RuntimeOptions extends ComputedLimits {
    language: string;
    version: SemVer;
    aliases?: string[];
    pkgdir: string;
    /**
     * Set only for packages that provide several languages, in which case it
     * names the providing package. Left undefined otherwise, which keeps it
     * absent from the GET /api/v2/runtimes response - part of the v2 contract.
     */
    runtime?: string;
}

/** Shape of a package's pkg-info.json on disk. */
interface PackageInfo {
    language: string;
    version: string;
    build_platform: string;
    aliases?: string[];
    provides?: {
        language: string;
        aliases?: string[];
        limit_overrides?: LanguageLimits;
    }[];
    limit_overrides?: LanguageLimits;
}

/** Every runtime currently registered. Mutated by load_package/unregister. */
export const runtimes: Runtime[] = [];

export class Runtime implements ComputedLimits {
    language: string;
    version: SemVer;
    aliases: string[];
    pkgdir: string;
    runtime?: string;
    timeouts: StageLimits;
    cpu_times: StageLimits;
    memory_limits: StageLimits;
    max_process_count: number;
    max_open_files: number;
    max_file_size: number;
    output_max_size: number;

    #compiled?: boolean;
    #env_vars?: string[];

    constructor({
        language,
        version,
        aliases,
        pkgdir,
        runtime,
        timeouts,
        cpu_times,
        memory_limits,
        max_process_count,
        max_open_files,
        max_file_size,
        output_max_size,
    }: RuntimeOptions) {
        this.language = language;
        this.version = version;
        this.aliases = aliases || [];
        this.pkgdir = pkgdir;
        this.runtime = runtime;
        this.timeouts = timeouts;
        this.cpu_times = cpu_times;
        this.memory_limits = memory_limits;
        this.max_process_count = max_process_count;
        this.max_open_files = max_open_files;
        this.max_file_size = max_file_size;
        this.output_max_size = output_max_size;
    }

    static compute_single_limit(
        language_name: string,
        limit_name: keyof LanguageLimits,
        language_limit_overrides?: LanguageLimits
    ): number {
        // `??`, not `||`: a limit deliberately overridden to 0 must be honoured
        // rather than treated as absent and silently replaced by the global.
        return (
            config.limit_overrides[language_name]?.[limit_name] ??
            language_limit_overrides?.[limit_name] ??
            config[limit_name]
        );
    }

    static compute_all_limits(
        language_name: string,
        language_limit_overrides?: LanguageLimits
    ): ComputedLimits {
        return {
            timeouts: {
                compile: this.compute_single_limit(
                    language_name,
                    'compile_timeout',
                    language_limit_overrides
                ),
                run: this.compute_single_limit(
                    language_name,
                    'run_timeout',
                    language_limit_overrides
                ),
            },
            cpu_times: {
                compile: this.compute_single_limit(
                    language_name,
                    'compile_cpu_time',
                    language_limit_overrides
                ),
                run: this.compute_single_limit(
                    language_name,
                    'run_cpu_time',
                    language_limit_overrides
                ),
            },
            memory_limits: {
                compile: this.compute_single_limit(
                    language_name,
                    'compile_memory_limit',
                    language_limit_overrides
                ),
                run: this.compute_single_limit(
                    language_name,
                    'run_memory_limit',
                    language_limit_overrides
                ),
            },
            max_process_count: this.compute_single_limit(
                language_name,
                'max_process_count',
                language_limit_overrides
            ),
            max_open_files: this.compute_single_limit(
                language_name,
                'max_open_files',
                language_limit_overrides
            ),
            max_file_size: this.compute_single_limit(
                language_name,
                'max_file_size',
                language_limit_overrides
            ),
            output_max_size: this.compute_single_limit(
                language_name,
                'output_max_size',
                language_limit_overrides
            ),
        };
    }

    static load_package(package_dir: string): void {
        const info: PackageInfo = JSON.parse(
            readFileSync(path.join(package_dir, 'pkg-info.json')).toString()
        );

        const { language, build_platform, aliases, provides, limit_overrides } =
            info;

        const version = semver.parse(info.version);
        if (version === null) {
            throw new Error(
                `Package ${language} has an unparseable version: ${info.version}`
            );
        }

        if (build_platform !== globals.platform) {
            logger.warn(
                `Package ${language}-${version} was built for platform ${build_platform}, ` +
                    `but our platform is ${globals.platform}`
            );
        }

        if (provides) {
            // Multiple languages in 1 package
            provides.forEach(lang => {
                runtimes.push(
                    new Runtime({
                        language: lang.language,
                        aliases: lang.aliases,
                        version,
                        pkgdir: package_dir,
                        runtime: language,
                        ...Runtime.compute_all_limits(
                            lang.language,
                            lang.limit_overrides
                        ),
                    })
                );
            });
        } else {
            runtimes.push(
                new Runtime({
                    language,
                    version,
                    aliases,
                    pkgdir: package_dir,
                    ...Runtime.compute_all_limits(language, limit_overrides),
                })
            );
        }

        logger.debug(`Package ${language}-${version} was loaded`);
    }

    get compiled(): boolean {
        if (this.#compiled === undefined) {
            this.#compiled = existsSync(path.join(this.pkgdir, 'compile'));
        }

        return this.#compiled;
    }

    get env_vars(): string[] {
        if (!this.#env_vars) {
            const env_file = path.join(this.pkgdir, '.env');
            const env_content = readFileSync(env_file).toString();

            this.#env_vars = env_content.trim().split('\n');
        }

        return this.#env_vars;
    }

    toString(): string {
        return `${this.language}-${this.version.raw}`;
    }

    unregister(): void {
        const index = runtimes.indexOf(this);
        runtimes.splice(index, 1); //Remove from runtimes list
    }
}

export function get_runtimes_matching_language_version(
    lang: string,
    ver: string
): Runtime[] {
    return runtimes.filter(
        rt =>
            (rt.language == lang || rt.aliases.includes(lang)) &&
            semver.satisfies(rt.version, ver)
    );
}

export function get_latest_runtime_matching_language_version(
    lang: string,
    ver: string
): Runtime | undefined {
    return get_runtimes_matching_language_version(lang, ver).sort((a, b) =>
        semver.rcompare(a.version, b.version)
    )[0];
}

export function get_runtime_by_name_and_version(
    runtime: string,
    ver: string
): Runtime | undefined {
    return runtimes.find(
        rt =>
            (rt.runtime == runtime ||
                (rt.runtime === undefined && rt.language == runtime)) &&
            semver.satisfies(rt.version, ver)
    );
}

export const load_package = Runtime.load_package;
