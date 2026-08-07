/**
 * Small typed logger, replacing the untyped `logplease` dependency.
 *
 * The output format deliberately matches what logplease produced, so operators
 * parsing piston's logs see no change:
 *
 *   2026-08-07T08:47:12.364Z [INFO]  index: API server started on 0.0.0.0:2000
 */

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'NONE'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4,
};

// Matches logplease's colouring so existing log-reading habits still work.
const COLOR: Record<Exclude<LogLevel, 'NONE'>, string> = {
    DEBUG: '\x1b[36m',
    INFO: '\x1b[32m',
    WARN: '\x1b[33m',
    ERROR: '\x1b[31m',
};

const RESET = '\x1b[0m';
const DIM = '\x1b[37m';
const BOLD = '\x1b[39;1m';

let current: LogLevel = 'INFO';

export function set_log_level(level: LogLevel): void {
    current = level;
}

export function is_log_level(value: string): value is LogLevel {
    return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Everything a caller can pass to a log method, after the message. */
type LogArg = unknown;

function format(part: LogArg): string {
    if (typeof part === 'string') return part;
    if (part instanceof Error) return part.stack ?? part.message;
    if (part === null) return 'null';
    if (part === undefined) return 'undefined';
    if (typeof part === 'object') {
        try {
            return JSON.stringify(part);
        } catch {
            return String(part);
        }
    }
    return String(part);
}

export interface Logger {
    debug(...parts: LogArg[]): void;
    info(...parts: LogArg[]): void;
    warn(...parts: LogArg[]): void;
    error(...parts: LogArg[]): void;
}

function emit(level: Exclude<LogLevel, 'NONE'>, name: string, parts: LogArg[]) {
    if (RANK[level] < RANK[current]) return;

    const stamp = new Date().toISOString();
    const label = level.padEnd(5, ' ');
    const message = parts.map(format).join(' ');
    const line = `${DIM}${stamp} ${COLOR[level]}[${label}]${RESET} ${BOLD}${name}${RESET}: ${message}`;

    // Anything WARN or worse goes to stderr, matching logplease.
    if (RANK[level] >= RANK.WARN) console.error(line);
    else console.log(line);
}

export function create(name: string): Logger {
    return {
        debug: (...p) => emit('DEBUG', name, p),
        info: (...p) => emit('INFO', name, p),
        warn: (...p) => emit('WARN', name, p),
        error: (...p) => emit('ERROR', name, p),
    };
}
