/**
 * Long-running package operations.
 *
 * `POST /api/v2/packages` is synchronous and frozen, which is fine when an
 * install is a tarball fetch. Building a package from source is not - it can
 * run for an hour - so those go through here instead: start it, get an id back,
 * then poll or stream the log.
 *
 * Everything lives in memory. An operation is a record of work in flight, not
 * durable state; the durable state is the package directory itself, which boot
 * re-derives from disk.
 */

import { randomUUID } from 'node:crypto';

import { create } from './logger.ts';
import { error_message } from './errors.ts';
import { TypedEmitter } from './typed_emitter.ts';

const logger = create('operations');

/** Completed operations kept for inspection before they are dropped. */
const RETAIN_COMPLETED = 50;

/** Log lines kept per operation. A from-source build can emit a great many. */
const MAX_LOG_LINES = 5000;

export type OperationKind = 'install' | 'uninstall';
export type OperationState = 'running' | 'succeeded' | 'failed';

export interface OperationEvents extends Record<string, unknown[]> {
    log: [line: string];
    state: [state: OperationState, error?: string];
}

export interface OperationView {
    id: string;
    kind: OperationKind;
    language: string;
    version: string;
    state: OperationState;
    started: number;
    finished?: number;
    error?: string;
}

export class Operation {
    readonly id = randomUUID();
    readonly kind: OperationKind;
    readonly language: string;
    readonly version: string;
    readonly started = Date.now();
    readonly events = new TypedEmitter<OperationEvents>();

    state: OperationState = 'running';
    finished?: number;
    error?: string;

    #log: string[] = [];
    #truncated = 0;

    constructor(kind: OperationKind, language: string, version: string) {
        this.kind = kind;
        this.language = language;
        this.version = version;
    }

    append(line: string): void {
        for (const part of line.split('\n')) {
            this.#log.push(part);
        }
        if (this.#log.length > MAX_LOG_LINES) {
            const dropped = this.#log.length - MAX_LOG_LINES;
            this.#log.splice(0, dropped);
            this.#truncated += dropped;
        }
        this.events.emit('log', line);
    }

    settle(state: OperationState, error?: string): void {
        this.state = state;
        this.finished = Date.now();
        if (error !== undefined) this.error = error;
        this.events.emit('state', state, error);
    }

    get log(): string {
        const head =
            this.#truncated > 0
                ? [`... ${this.#truncated} earlier lines dropped`]
                : [];
        return [...head, ...this.#log].join('\n');
    }

    get view(): OperationView {
        return {
            id: this.id,
            kind: this.kind,
            language: this.language,
            version: this.version,
            state: this.state,
            started: this.started,
            ...(this.finished === undefined ? {} : { finished: this.finished }),
            ...(this.error === undefined ? {} : { error: this.error }),
        };
    }
}

const operations = new Map<string, Operation>();

/** One in-flight operation per package, so two installs cannot race a directory. */
const in_flight = new Map<string, Operation>();

const slot_key = (language: string, version: string) =>
    `${language}-${version}`;

export function get_operation(id: string): Operation | undefined {
    return operations.get(id);
}

export function list_operations(): OperationView[] {
    return [...operations.values()]
        .sort((a, b) => b.started - a.started)
        .map(operation => operation.view);
}

export function running_for(
    language: string,
    version: string
): Operation | undefined {
    return in_flight.get(slot_key(language, version));
}

/** Drops the oldest settled operations once there are more than we retain. */
function prune(): void {
    const settled = [...operations.values()]
        .filter(operation => operation.state !== 'running')
        .sort((a, b) => (a.finished ?? 0) - (b.finished ?? 0));

    for (const operation of settled.slice(0, -RETAIN_COMPLETED)) {
        operations.delete(operation.id);
    }
}

/**
 * Starts `work` in the background and returns immediately. Rejects only if an
 * operation for the same package is already running - the work's own failure is
 * reported through the operation's state, not thrown here.
 */
export function start(
    kind: OperationKind,
    language: string,
    version: string,
    work: (log: (line: string) => void) => Promise<unknown>
): Operation {
    const key = slot_key(language, version);
    const existing = in_flight.get(key);
    if (existing) {
        throw new Error(
            `${existing.kind} of ${language}-${version} is already running`
        );
    }

    const operation = new Operation(kind, language, version);
    operations.set(operation.id, operation);
    in_flight.set(key, operation);

    // Intentionally not awaited: the caller gets an id back straight away.
    void work(line => operation.append(line))
        .then(() => {
            operation.settle('succeeded');
        })
        .catch((e: unknown) => {
            const message = error_message(e);
            logger.error(`${kind} of ${language}-${version} failed:`, message);
            operation.append(`Error: ${message}`);
            operation.settle('failed', message);
        })
        .finally(() => {
            in_flight.delete(key);
            prune();
        });

    return operation;
}

/** Test seam. Not reachable over HTTP. */
export function reset_operations(): void {
    operations.clear();
    in_flight.clear();
}
