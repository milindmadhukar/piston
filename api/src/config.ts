import { existsSync } from 'node:fs';
import {
    create,
    is_log_level,
    set_log_level,
    type LogLevel,
} from './logger.ts';

const logger = create('config');

/** Limits a package may override per-language, and operators may override via PISTON_LIMIT_OVERRIDES. */
export interface LanguageLimits {
    max_process_count?: number;
    max_open_files?: number;
    max_file_size?: number;
    compile_memory_limit?: number;
    run_memory_limit?: number;
    compile_timeout?: number;
    run_timeout?: number;
    compile_cpu_time?: number;
    run_cpu_time?: number;
    output_max_size?: number;
}

export type LimitOverrides = Record<string, LanguageLimits>;

const OVERRIDABLE_LIMITS = [
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

type OverridableLimit = (typeof OVERRIDABLE_LIMITS)[number];

function is_overridable_limit(key: string): key is OverridableLimit {
    return (OVERRIDABLE_LIMITS as readonly string[]).includes(key);
}

export interface PistonConfig {
    log_level: LogLevel;
    bind_address: string;
    data_directory: string;
    runner_uid_min: number;
    runner_uid_max: number;
    runner_gid_min: number;
    runner_gid_max: number;
    disable_networking: boolean;
    output_max_size: number;
    max_process_count: number;
    max_open_files: number;
    max_file_size: number;
    compile_timeout: number;
    run_timeout: number;
    compile_cpu_time: number;
    run_cpu_time: number;
    compile_memory_limit: number;
    run_memory_limit: number;
    repo_url: string;
    max_concurrent_jobs: number;
    limit_overrides: LimitOverrides;
}

/** Returns `true` when valid, otherwise the human-readable reason. */
type Validator<T> = (value: T, raw: unknown) => true | string;

interface Option<T> {
    desc: string;
    default: T;
    /** Parses the raw environment string. May return null to signal a parse failure. */
    parser?: (raw: string) => T | null;
    validators: Validator<T>[];
}

/** Every config key must have exactly one correctly-typed option entry. */
type Options = { [K in keyof PistonConfig]: Option<PistonConfig[K]> };

const parse_int_option = (raw: string): number => parseInt(raw);

const numeric: Validator<number>[] = [
    (x, raw) => !isNaN(x) || `${raw} is not a number`,
];

const options: Options = {
    log_level: {
        desc: 'Level of data to log',
        default: 'INFO',
        // Passed through unchecked so the validator below produces the original
        // operator-facing message; anything invalid exits before it is used.
        parser: raw => raw as LogLevel,
        validators: [
            (x, raw) =>
                is_log_level(x) || `Log level ${String(raw)} does not exist`,
        ],
    },
    bind_address: {
        desc: 'Address to bind REST API on',
        default: `0.0.0.0:${process.env['PORT'] || 2000}`,
        validators: [],
    },
    data_directory: {
        desc: 'Absolute path to store all piston related data at',
        default: '/piston',
        validators: [x => existsSync(x) || `Directory ${x} does not exist`],
    },
    runner_uid_min: {
        desc: 'Minimum uid to use for runner',
        default: 1001,
        parser: parse_int_option,
        validators: numeric,
    },
    runner_uid_max: {
        desc: 'Maximum uid to use for runner',
        default: 1500,
        parser: parse_int_option,
        validators: numeric,
    },
    runner_gid_min: {
        desc: 'Minimum gid to use for runner',
        default: 1001,
        parser: parse_int_option,
        validators: numeric,
    },
    runner_gid_max: {
        desc: 'Maximum gid to use for runner',
        default: 1500,
        parser: parse_int_option,
        validators: numeric,
    },
    disable_networking: {
        desc: 'Set to true to disable networking',
        default: true,
        parser: raw => raw === 'true',
        validators: [x => typeof x === 'boolean' || `${x} is not a boolean`],
    },
    output_max_size: {
        desc: 'Max size of each stdio buffer',
        default: 1024,
        parser: parse_int_option,
        validators: numeric,
    },
    max_process_count: {
        desc: 'Max number of processes per job',
        default: 64,
        parser: parse_int_option,
        validators: numeric,
    },
    max_open_files: {
        desc: 'Max number of open files per job',
        default: 2048,
        parser: parse_int_option,
        validators: numeric,
    },
    max_file_size: {
        desc: 'Max file size in bytes for a file',
        default: 10000000, //10MB
        parser: parse_int_option,
        validators: numeric,
    },
    compile_timeout: {
        desc: 'Max time allowed for compile stage in milliseconds',
        default: 10000, // 10 seconds
        parser: parse_int_option,
        validators: numeric,
    },
    run_timeout: {
        desc: 'Max time allowed for run stage in milliseconds',
        default: 3000, // 3 seconds
        parser: parse_int_option,
        validators: numeric,
    },
    compile_cpu_time: {
        desc: 'Max CPU time allowed for compile stage in milliseconds',
        default: 10000, // 10 seconds
        parser: parse_int_option,
        validators: numeric,
    },
    run_cpu_time: {
        desc: 'Max CPU time allowed for run stage in milliseconds',
        default: 3000, // 3 seconds
        parser: parse_int_option,
        validators: numeric,
    },
    compile_memory_limit: {
        desc: 'Max memory usage for compile stage in bytes (set to -1 for no limit)',
        default: -1, // no limit
        parser: parse_int_option,
        validators: numeric,
    },
    run_memory_limit: {
        desc: 'Max memory usage for run stage in bytes (set to -1 for no limit)',
        default: -1, // no limit
        parser: parse_int_option,
        validators: numeric,
    },
    repo_url: {
        desc: 'URL of repo index',
        default:
            'https://github.com/engineer-man/piston/releases/download/pkgs/index',
        validators: [],
    },
    max_concurrent_jobs: {
        desc: 'Maximum number of concurrent jobs to run at one time',
        default: 64,
        parser: parse_int_option,
        validators: [x => x > 0 || `${x} cannot be negative`],
    },
    limit_overrides: {
        desc: 'Per-language exceptions in JSON format for each of:\
        max_process_count, max_open_files, max_file_size, compile_memory_limit,\
        run_memory_limit, compile_timeout, run_timeout, compile_cpu_time, run_cpu_time, output_max_size',
        default: {},
        parser: parse_overrides,
        validators: [
            x => !!x || `Failed to parse the overrides\n${x}`,
            validate_overrides,
        ],
    },
};

Object.freeze(options);

function apply_validators<T>(
    validators: Validator<T>[],
    value: T,
    raw: unknown
): true | string {
    for (const validator of validators) {
        const validation_response = validator(value, raw);
        if (validation_response !== true) {
            return validation_response;
        }
    }
    return true;
}

function parse_overrides(overrides_string: string): LimitOverrides | null {
    function get_parsed_json_or_null(overrides: string): unknown {
        try {
            return JSON.parse(overrides);
        } catch {
            return null;
        }
    }

    const overrides = get_parsed_json_or_null(overrides_string);
    if (overrides === null || typeof overrides !== 'object') {
        return null;
    }

    const parsed_overrides: LimitOverrides = {};
    for (const [language, language_overrides] of Object.entries(overrides)) {
        if (
            typeof language_overrides !== 'object' ||
            language_overrides === null
        ) {
            return null;
        }
        const parsed_language: LanguageLimits = {};
        for (const [key, raw_value] of Object.entries(language_overrides)) {
            if (!is_overridable_limit(key)) {
                return null;
            }
            // Every overridable limit is numeric, and each has a parser.
            const option = options[key];
            const parser = option.parser;
            if (!parser) return null;
            const parsed_value = parser(String(raw_value));
            if (parsed_value === null) return null;
            parsed_language[key] = parsed_value;
        }
        parsed_overrides[language] = parsed_language;
    }
    return parsed_overrides;
}

function validate_overrides(overrides: LimitOverrides): true | string {
    for (const [language, language_overrides] of Object.entries(overrides)) {
        for (const [key, value] of Object.entries(language_overrides)) {
            if (!is_overridable_limit(key)) {
                return `In overridden option ${key} for ${language}, ${key} is not an overridable option`;
            }
            const option = options[key];
            const validation_response = apply_validators(
                option.validators,
                value,
                value
            );
            if (validation_response !== true) {
                return `In overridden option ${key} for ${language}, ${validation_response}`;
            }
        }
    }
    return true;
}

logger.info(`Loading Configuration from environment`);

/**
 * Resolves one option from the environment, preserving the original semantics:
 * when the variable is unset the default is used and validated against itself;
 * when it is set the parsed value is validated against the raw string.
 * A failure exits the process, exactly as before.
 */
function resolve<K extends keyof PistonConfig>(name: K): PistonConfig[K] {
    const option: Option<PistonConfig[K]> = options[name];
    const env_key = 'PISTON_' + name.toUpperCase();
    const env_val = process.env[env_key];

    let value: PistonConfig[K];
    let raw: unknown;

    if (env_val === undefined) {
        value = option.default;
        raw = option.default;
    } else {
        const parser = option.parser;
        // Options without a parser take the raw string. The Options mapped type
        // guarantees those are exactly the string-valued keys.
        const parsed = parser ? parser(env_val) : (env_val as PistonConfig[K]);
        if (parsed === null) {
            logger.error(
                `Config option ${name} failed validation:`,
                `Failed to parse ${env_val}`
            );
            process.exit(1);
        }
        value = parsed;
        raw = env_val;
    }

    const validation_response = apply_validators(option.validators, value, raw);
    if (validation_response !== true) {
        logger.error(
            `Config option ${name} failed validation:`,
            validation_response
        );
        process.exit(1);
    }

    return value;
}

const config: PistonConfig = {
    log_level: resolve('log_level'),
    bind_address: resolve('bind_address'),
    data_directory: resolve('data_directory'),
    runner_uid_min: resolve('runner_uid_min'),
    runner_uid_max: resolve('runner_uid_max'),
    runner_gid_min: resolve('runner_gid_min'),
    runner_gid_max: resolve('runner_gid_max'),
    disable_networking: resolve('disable_networking'),
    output_max_size: resolve('output_max_size'),
    max_process_count: resolve('max_process_count'),
    max_open_files: resolve('max_open_files'),
    max_file_size: resolve('max_file_size'),
    compile_timeout: resolve('compile_timeout'),
    run_timeout: resolve('run_timeout'),
    compile_cpu_time: resolve('compile_cpu_time'),
    run_cpu_time: resolve('run_cpu_time'),
    compile_memory_limit: resolve('compile_memory_limit'),
    run_memory_limit: resolve('run_memory_limit'),
    repo_url: resolve('repo_url'),
    max_concurrent_jobs: resolve('max_concurrent_jobs'),
    limit_overrides: resolve('limit_overrides'),
};

set_log_level(config.log_level);

logger.info('Configuration successfully loaded');

export default config;
