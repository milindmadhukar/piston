// Globals are things the user shouldn't change in config, but is good to not use inline constants for
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Inlined replacement for the `is-docker` package - same two checks it made.
 */
function is_docker(): boolean {
    const has_dockerenv = (() => {
        try {
            statSync('/.dockerenv');
            return true;
        } catch {
            return false;
        }
    })();

    if (has_dockerenv) return true;

    try {
        return readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
    } catch {
        return false;
    }
}

const os_release_id = readFileSync('/etc/os-release')
    .toString()
    .split('\n')
    .find(x => x.startsWith('ID'))
    ?.replace('ID=', '');

const platform = `${is_docker() ? 'docker' : 'baremetal'}-${os_release_id}`;

// `..` from src/ resolves to the package root both in-repo and in the image,
// since Bun runs the TypeScript directly rather than from a build directory.
const package_json: { version: string } = JSON.parse(
    readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8')
);

/**
 * Signal number to name. Deliberately includes names Node has no constant for
 * (SIGRTMIN+n): a client may send any of these and the API must accept them,
 * so this table defines the accepted set for /api/v2/connect. Narrowing it is
 * a breaking change - see CLAUDE.md.
 */
const SIGNALS = {
    1: 'SIGHUP',
    2: 'SIGINT',
    3: 'SIGQUIT',
    4: 'SIGILL',
    5: 'SIGTRAP',
    6: 'SIGABRT',
    7: 'SIGBUS',
    8: 'SIGFPE',
    9: 'SIGKILL',
    10: 'SIGUSR1',
    11: 'SIGSEGV',
    12: 'SIGUSR2',
    13: 'SIGPIPE',
    14: 'SIGALRM',
    15: 'SIGTERM',
    16: 'SIGSTKFLT',
    17: 'SIGCHLD',
    18: 'SIGCONT',
    19: 'SIGSTOP',
    20: 'SIGTSTP',
    21: 'SIGTTIN',
    22: 'SIGTTOU',
    23: 'SIGURG',
    24: 'SIGXCPU',
    25: 'SIGXFSZ',
    26: 'SIGVTALRM',
    27: 'SIGPROF',
    28: 'SIGWINCH',
    29: 'SIGIO',
    30: 'SIGPWR',
    31: 'SIGSYS',
    34: 'SIGRTMIN',
    35: 'SIGRTMIN+1',
    36: 'SIGRTMIN+2',
    37: 'SIGRTMIN+3',
    38: 'SIGRTMIN+4',
    39: 'SIGRTMIN+5',
    40: 'SIGRTMIN+6',
    41: 'SIGRTMIN+7',
    42: 'SIGRTMIN+8',
    43: 'SIGRTMIN+9',
    44: 'SIGRTMIN+10',
    45: 'SIGRTMIN+11',
    46: 'SIGRTMIN+12',
    47: 'SIGRTMIN+13',
    48: 'SIGRTMIN+14',
    49: 'SIGRTMIN+15',
    50: 'SIGRTMAX-14',
    51: 'SIGRTMAX-13',
    52: 'SIGRTMAX-12',
    53: 'SIGRTMAX-11',
    54: 'SIGRTMAX-10',
    55: 'SIGRTMAX-9',
    56: 'SIGRTMAX-8',
    57: 'SIGRTMAX-7',
    58: 'SIGRTMAX-6',
    59: 'SIGRTMAX-5',
    60: 'SIGRTMAX-4',
    61: 'SIGRTMAX-3',
    62: 'SIGRTMAX-2',
    63: 'SIGRTMAX-1',
    64: 'SIGRTMAX',
} as const;

/**
 * Every signal name the API accepts on /api/v2/connect. Derived from the table
 * above so the two can never drift.
 */
export type SignalName = (typeof SIGNALS)[keyof typeof SIGNALS];

/**
 * Maps isolate's `exitsig` number to a name.
 *
 * The cast is confined here: the table is declared `as const` to derive
 * SignalName, which leaves it without a numeric index signature.
 */
export function signal_for_code(code: number): SignalName | null {
    return (SIGNALS as Record<number, SignalName | undefined>)[code] ?? null;
}

/**
 * Whether a client-supplied string is a signal the API accepts.
 *
 * This is the runtime acceptance check for `/api/v2/connect`. Narrowing what it
 * returns true for turns a previously-accepted request into a 4005 close, which
 * is a breaking change - see CLAUDE.md.
 */
export function is_known_signal(signal: unknown): signal is SignalName {
    return (
        typeof signal === 'string' &&
        (Object.values(SIGNALS) as string[]).includes(signal)
    );
}

export interface DataDirectories {
    packages: string;
}

const globals = {
    data_directories: {
        packages: 'packages',
    } as DataDirectories,
    version: package_json.version,
    platform,
    pkg_installed_file: '.ppman-installed', //Used as indication for if a package was installed
    clean_directories: ['/dev/shm', '/run/lock', '/tmp', '/var/tmp'],
    SIGNALS,
};

export default globals;
export { SIGNALS, platform };
