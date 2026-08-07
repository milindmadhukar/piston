/**
 * Helpers for the `unknown` catch bindings that `useUnknownInCatchVariables`
 * gives us.
 */

/**
 * A request that failed v2 validation.
 *
 * The message is public contract: it is the `message` field of the 400 body on
 * /api/v2/execute, and the `message` of the `error` frame sent over
 * /api/v2/connect before a 4002 close. Clients match on these strings, so
 * neither the wording nor the order the checks run in may change.
 */
export class JobValidationError extends Error {
    override readonly name = 'JobValidationError';

    constructor(message: string) {
        super(message);
    }
}

/** Best-effort message for anything that can be thrown. */
export function error_message(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    if (
        typeof e === 'object' &&
        e !== null &&
        'message' in e &&
        typeof e.message === 'string'
    ) {
        return e.message;
    }
    return String(e);
}
