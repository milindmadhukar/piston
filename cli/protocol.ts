/**
 * Client-side view of the /api/v2 contract.
 *
 * The API owns the authoritative shapes; this is the narrower subset the CLI
 * reads. It is deliberately a separate file rather than an import, because the
 * API's docker build context is `api/` and cannot reach outside it.
 */

export interface SubmittedFile {
    name: string;
    content: string;
    encoding: 'utf8' | 'base64' | 'hex';
}

export interface ExecuteRequest {
    language: string;
    version: string;
    files: SubmittedFile[];
    args?: string[];
    stdin?: string;
    compile_timeout?: number;
    run_timeout?: number;
}

export interface StageResult {
    signal: string | null;
    stdout: string;
    stderr: string;
    code: number | null;
    output: string;
    memory: number | null;
    message: string | null;
    status: string | null;
    cpu_time: number | null;
    wall_time: number | null;
}

export interface ExecuteResponse {
    compile?: StageResult;
    run?: StageResult;
    language: string;
    version: string;
}

export interface RuntimeEntry {
    language: string;
    version: string;
    aliases: string[];
    runtime?: string;
}

export interface PackageEntry {
    language: string;
    language_version: string;
    installed: boolean;
}

export interface PackageResult {
    language?: string;
    version?: string;
    message?: string;
}

// ---- WebSocket messages, /api/v2/connect ----

export type ServerMessage =
    | { type: 'runtime'; language: string; version: string }
    | { type: 'stage'; stage: string }
    | { type: 'data'; stream: 'stdout' | 'stderr'; data: string }
    | {
          type: 'exit';
          stage: string;
          code: number | null;
          signal: string | null;
          error?: string;
      }
    | { type: 'error'; message: string };

/**
 * Signals the API accepts (api/src/globals.ts), minus the ones the process
 * cannot trap. Sending anything outside the API's set closes the socket with
 * 4005.
 */
export const TRAPPABLE_SIGNALS: readonly NodeJS.Signals[] = [
    'SIGABRT',
    'SIGALRM',
    'SIGBUS',
    'SIGCHLD',
    'SIGCONT',
    'SIGFPE',
    'SIGHUP',
    'SIGILL',
    'SIGINT',
    'SIGIO',
    'SIGPIPE',
    'SIGPROF',
    'SIGPWR',
    'SIGQUIT',
    'SIGSEGV',
    'SIGSTKFLT',
    'SIGTSTP',
    'SIGSYS',
    'SIGTERM',
    'SIGTRAP',
    'SIGTTIN',
    'SIGTTOU',
    'SIGURG',
    'SIGUSR1',
    'SIGUSR2',
    'SIGVTALRM',
    'SIGXCPU',
    'SIGXFSZ',
    'SIGWINCH',
];
