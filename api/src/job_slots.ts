/**
 * Bounds how many jobs run concurrently.
 *
 * This is the primitive behind the invariant CLAUDE.md cares most about: a job
 * that never releases its slot leaks capacity permanently, and once every slot
 * has leaked the API accepts requests and never runs them. Extracted into a
 * named class so there is one place to audit and it can be tested without a
 * container.
 *
 * Acquire/release must be exactly paired. `Job.prime()` acquires and
 * `Job.cleanup()` releases; cleanup runs in a finally on both transports.
 */
export class JobSlots {
    #available: number;
    readonly #waiting: (() => void)[] = [];

    constructor(capacity: number) {
        this.#available = capacity;
    }

    /** Resolves once a slot is held by the caller. */
    async acquire(): Promise<void> {
        if (this.#available < 1) {
            await new Promise<void>(resolve => {
                this.#waiting.push(resolve);
            });
        }
        this.#available--;
    }

    /** Returns a slot and wakes the longest-waiting acquirer, if any. */
    release(): void {
        this.#available++;
        const next = this.#waiting.shift();
        if (next) next();
    }

    /** Slots not currently held. Diagnostics and tests only. */
    get available(): number {
        return this.#available;
    }

    /** Callers parked waiting for a slot. Diagnostics and tests only. */
    get waiting(): number {
        return this.#waiting.length;
    }
}
