/**
 * The /api/v2 wire contract.
 *
 * This module exists because the protocol is shared by `job.ts`, `api/v2.ts`
 * and `index.ts` and owned by none of them. Domain types that belong to a
 * single module stay in that module - this is a boundary, not a types bucket.
 *
 * v2 is frozen (see CLAUDE.md). Everything here is public surface: message
 * `type` values, their payload fields, the close codes, and the documented
 * status letters. `readme.md` is the authority when code and docs disagree.
 */

import type { SignalName } from './globals.ts';

/** The two execution stages a job can report. */
export type Stage = 'compile' | 'run';

/** The streams the sandboxed program can write to. */
export type Stream = 'stdout' | 'stderr';

/** The two-letter status letters documented in readme.md. */
export type KnownJobStatus = 'RE' | 'SG' | 'TO' | 'OL' | 'EL' | 'XX';

/**
 * isolate writes this field into its metadata file, so an unrecognised value is
 * possible in principle even though the documented set is complete. The union
 * keeps autocomplete for the documented letters without claiming at the type
 * level that the set is exhaustive at runtime.
 */
export type JobStatus = KnownJobStatus | (string & {});

/** The `exit` message payload, as documented in readme.md. */
export interface ExitStatus {
    code: number | null;
    signal: SignalName | null;
}

// ------------------------------------------------------- server -> client

export type ServerMessage =
    | { type: 'runtime'; language: string; version: string }
    | { type: 'stage'; stage: Stage }
    | { type: 'data'; stream: Stream; data: string }
    | ({ type: 'exit'; stage: Stage } & ExitStatus)
    | { type: 'error'; message: string };

// ------------------------------------------------------- client -> server

/**
 * A decoded frame from a client.
 *
 * Deliberately *not* a discriminated union. The server accepts any `type` it
 * does not recognise and ignores it, so modelling this as a closed union would
 * misdescribe the wire: what actually arrives is an arbitrary object carrying a
 * string `type`. Every other field stays `unknown` because it is untrusted
 * until a validator has looked at it - `get_job` owns the `init` fields, and
 * `is_known_signal` owns `signal`.
 */
export interface ClientMessage {
    type: string;
    stream?: unknown;
    data?: unknown;
    [field: string]: unknown;
}

/**
 * Narrows a decoded payload to a ClientMessage.
 *
 * Deliberately permissive: anything with a string `type` is accepted, including
 * types the server does not handle. Rejecting unknown types here would turn a
 * previously-ignored message into a `4002` close, which is a breaking change.
 * Returns null only when the payload could not be a message at all, which the
 * caller treats the same way it always has - by ignoring it.
 */
export function as_client_message(payload: unknown): ClientMessage | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const { type } = payload as { type?: unknown };
    if (typeof type !== 'string') return null;
    return payload as ClientMessage;
}

// ------------------------------------------------------------ close codes

/**
 * The 4000-4999 range documented in readme.md. Values are contract; the names
 * are ours.
 */
export const CLOSE_CODES = {
    ALREADY_INITIALIZED: 4000,
    INITIALIZATION_TIMEOUT: 4001,
    NOTIFIED_ERROR: 4002,
    NOT_YET_INITIALIZED: 4003,
    ONLY_STDIN_WRITABLE: 4004,
    INVALID_SIGNAL: 4005,
    JOB_COMPLETED: 4999,
} as const;

/**
 * The reason strings paired with each close code. These are observable by
 * clients, so they are pinned here rather than written inline at each call.
 */
export const CLOSE_REASONS = {
    [CLOSE_CODES.ALREADY_INITIALIZED]: 'Already Initialized',
    [CLOSE_CODES.INITIALIZATION_TIMEOUT]: 'Initialization Timeout',
    [CLOSE_CODES.NOTIFIED_ERROR]: 'Notified Error',
    [CLOSE_CODES.NOT_YET_INITIALIZED]: 'Not yet initialized',
    [CLOSE_CODES.ONLY_STDIN_WRITABLE]: 'Can only write to stdin',
    [CLOSE_CODES.INVALID_SIGNAL]: 'Invalid signal',
    [CLOSE_CODES.JOB_COMPLETED]: 'Job Completed',
} as const satisfies Record<CloseCode, string>;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];
