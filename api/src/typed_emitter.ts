/**
 * A minimal event emitter whose event names and payloads are checked.
 *
 * Node's EventEmitter types every listener argument as `any`, so a typo in an
 * event name is a silent no-op. On the job event bus one of those events is
 * what kills a running stage when a socket closes, and a silent no-op there
 * leaks a job slot - so the names are worth checking at compile time.
 */

type Listener<Args extends unknown[]> = (...args: Args) => void;

export class TypedEmitter<Events extends Record<keyof Events, unknown[]>> {
    readonly #listeners: {
        [K in keyof Events]?: Set<Listener<Events[K]>>;
    } = {};

    on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
        (this.#listeners[event] ??= new Set()).add(listener);
        return this;
    }

    off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
        this.#listeners[event]?.delete(listener);
        return this;
    }

    emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
        const listeners = this.#listeners[event];
        if (listeners === undefined) return;
        // Iterate a copy: a listener may remove itself while being called, which
        // safe_call does when a stage ends.
        for (const listener of [...listeners]) listener(...args);
    }

    /** Number of listeners for an event. Used by tests to assert cleanup. */
    listener_count<K extends keyof Events>(event: K): number {
        return this.#listeners[event]?.size ?? 0;
    }
}
