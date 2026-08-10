import type { ServerWebSocket } from 'bun';

import {
    runtimes,
    get_latest_runtime_matching_language_version,
} from '../runtime.ts';
import {
    Job,
    new_job_event_bus,
    type JobEventBus,
    type SubmittedFile,
} from '../job.ts';
import Package, { type PackageResult } from '../package.ts';
import {
    get_operation,
    list_operations,
    start,
    type Operation,
} from '../operations.ts';
import { is_known_signal } from '../globals.ts';
import { create } from '../logger.ts';
import { error_message, JobValidationError } from '../errors.ts';
import {
    as_client_message,
    CLOSE_CODES,
    CLOSE_REASONS,
    type CloseCode,
    type ServerMessage,
    type Stage,
} from '../protocol.ts';

const logger = create('api/v2');

export const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
} as const;

export function json_response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: JSON_HEADERS,
    });
}

/** A response with no body and no content-type, as `res.status(n).send()` gave. */
export function empty_response(status: number): Response {
    return new Response(null, { status });
}

// --------------------------------------------------------------- job setup

const CONSTRAINTS = ['memory_limit', 'timeout', 'cpu_time'] as const;
const STAGES = ['compile', 'run'] as const satisfies readonly Stage[];

type Constraint = (typeof CONSTRAINTS)[number];

/** e.g. `run_timeout`, `compile_memory_limit`. */
type ConstraintField = `${Stage}_${Constraint}`;

/**
 * A decoded execute or init payload.
 *
 * Every field is `unknown` because it is attacker-supplied; `get_job` below is
 * the only thing that decides what any of it means. The fields read are
 * `language`, `version`, `args`, `stdin`, `files`, and the constraint fields
 * enumerated by ConstraintField.
 *
 * Modelled as a record rather than an all-optional interface deliberately: an
 * interface of only-optional members is a "weak type", which TypeScript refuses
 * to accept a websocket frame for on the grounds that they share no declared
 * property names.
 */
export type JobRequest = Readonly<Record<string, unknown>>;

/** Ends validation. Declared as a function so control flow narrows through it. */
function fail(message: string): never {
    throw new JobValidationError(message);
}

/**
 * Whether a value can be used as a submitted file.
 *
 * Only `content` is checked, which is exactly what v2 has always validated.
 * Tightening this - rejecting a numeric `name`, say - would turn a currently
 * accepted request into a 400, so it deliberately stays loose.
 */
function is_submitted_file(value: unknown): value is SubmittedFile {
    return (
        typeof value === 'object' &&
        value !== null &&
        'content' in value &&
        typeof value.content === 'string'
    );
}

/**
 * Validates a request body and builds a Job, or throws a JobValidationError.
 *
 * The order and wording of every check is part of the v2 contract - clients
 * match on these messages, and they are also what a WebSocket client receives
 * in an `error` frame. Do not reorder or reword them.
 */
export function get_job(body: JobRequest): Job {
    const { language, version, args, stdin, files } = body;

    if (typeof language !== 'string' || !language) {
        fail('language is required as a string');
    }
    if (typeof version !== 'string' || !version) {
        fail('version is required as a string');
    }
    if (!Array.isArray(files)) {
        fail('files is required as an array');
    }

    const file_list: SubmittedFile[] = files.map((file, i) =>
        is_submitted_file(file)
            ? file
            : fail(`files[${i}].content is required as a string`)
    );

    const rt = get_latest_runtime_matching_language_version(language, version);
    if (rt === undefined) {
        fail(`${language}-${version} runtime is unknown`);
    }

    if (
        rt.language !== 'file' &&
        !file_list.some(file => !file.encoding || file.encoding === 'utf8')
    ) {
        fail('files must include at least one utf8 encoded file');
    }

    for (const constraint of CONSTRAINTS) {
        for (const stage of STAGES) {
            const field: ConstraintField = `${stage}_${constraint}`;
            const value = body[field];
            const configured_limit = rt[`${constraint}s`][stage];

            if (!value) {
                continue;
            }
            if (typeof value !== 'number') {
                fail(`If specified, ${field} must be a number`);
            }
            if (configured_limit <= 0) {
                continue;
            }
            if (value > configured_limit) {
                fail(
                    `${field} cannot exceed the configured limit of ${configured_limit}`
                );
            }
            if (value < 0) {
                fail(`${field} must be non-negative`);
            }
        }
    }

    /** A constraint that survived validation is a number, or absent. */
    const limit = (field: ConstraintField): number | undefined => {
        const value = body[field];
        return typeof value === 'number' ? value : undefined;
    };

    return new Job({
        runtime: rt,
        args: Array.isArray(args) ? args.map(String) : [],
        stdin: typeof stdin === 'string' ? stdin : '',
        files: file_list,
        timeouts: {
            run: limit('run_timeout') ?? rt.timeouts.run,
            compile: limit('compile_timeout') ?? rt.timeouts.compile,
        },
        cpu_times: {
            run: limit('run_cpu_time') ?? rt.cpu_times.run,
            compile: limit('compile_cpu_time') ?? rt.cpu_times.compile,
        },
        memory_limits: {
            run: limit('run_memory_limit') ?? rt.memory_limits.run,
            compile: limit('compile_memory_limit') ?? rt.memory_limits.compile,
        },
    });
}

// ------------------------------------------------------------- http routes

export async function handle_execute(body: JobRequest): Promise<Response> {
    let job: Job;
    try {
        job = get_job(body);
    } catch (error) {
        return json_response(400, { message: error_message(error) });
    }

    let response: Response;
    try {
        const box = await job.prime();

        const result = await job.execute(box);
        // Backward compatibility when the run stage is not started
        if (result.run === undefined) {
            result.run = result.compile;
        }

        response = json_response(200, result);
    } catch (error) {
        logger.error(`Error executing job: ${job.uuid}:\n${error}`);
        response = empty_response(500);
    }

    // A cleanup failure replaces whatever the run produced, as it always has.
    try {
        await job.cleanup();
    } catch (error) {
        logger.error(`Error cleaning up job: ${job.uuid}:\n${error}`);
        return empty_response(500);
    }

    return response;
}

export function handle_runtimes(): Response {
    return json_response(
        200,
        runtimes.map(rt => ({
            language: rt.language,
            version: rt.version.raw,
            aliases: rt.aliases,
            runtime: rt.runtime,
        }))
    );
}

export async function handle_list_packages(): Promise<Response> {
    logger.debug('Request to list packages');

    let packages;
    try {
        packages = await Package.get_package_list();
    } catch (e) {
        // The package index lives on a remote host, so every lookup can fail on
        // a network error. Never let that reject to the top level.
        logger.error(
            'Error while fetching the package list:',
            error_message(e)
        );
        return json_response(500, { message: error_message(e) });
    }

    return json_response(
        200,
        packages.map(pkg => ({
            language: pkg.language,
            language_version: pkg.version.raw,
            installed: pkg.installed,
        }))
    );
}

interface PackageRequest {
    language?: unknown;
    version?: unknown;
    /** Operations only; anything other than "uninstall" means install. */
    kind?: unknown;
}

/**
 * Shared shape of POST and DELETE /api/v2/packages: resolve the package from the
 * remote index, 404 if it is not there, then run the action.
 */
async function handle_package_action(
    body: PackageRequest,
    verb: 'install' | 'uninstall',
    act: (pkg: Package) => Promise<PackageResult>
): Promise<Response> {
    logger.debug(`Request to ${verb} package`);

    const { language, version } = body;

    let pkg: Package | null;
    try {
        pkg = await Package.get_package(String(language), String(version));
    } catch (e) {
        logger.error(
            `Error while fetching package ${language}-${version}:`,
            error_message(e)
        );
        return json_response(500, { message: error_message(e) });
    }

    if (pkg == null) {
        return json_response(404, {
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    try {
        return json_response(200, await act(pkg));
    } catch (e) {
        logger.error(
            `Error while ${verb}ing package ${pkg.language}-${pkg.version}:`,
            error_message(e)
        );
        return json_response(500, { message: error_message(e) });
    }
}

export function handle_install_package(
    body: PackageRequest
): Promise<Response> {
    return handle_package_action(body, 'install', pkg => pkg.install());
}

export function handle_uninstall_package(
    body: PackageRequest
): Promise<Response> {
    return handle_package_action(body, 'uninstall', pkg => pkg.uninstall());
}

// ------------------------------------------------------------- operations

/**
 * Async install/uninstall.
 *
 * POST /api/v2/packages stays exactly as it always was - synchronous, and the
 * documented response shape. These are additional endpoints, which is what the
 * v2 freeze allows, and they exist because building a package from source can
 * take an hour and nobody wants that on one HTTP request.
 */
export async function handle_start_operation(
    body: PackageRequest
): Promise<Response> {
    const { language, version } = body;
    const kind = body.kind === 'uninstall' ? 'uninstall' : 'install';

    let pkg: Package | null;
    try {
        pkg = await Package.get_package(String(language), String(version));
    } catch (e) {
        return json_response(500, { message: error_message(e) });
    }

    if (pkg == null) {
        return json_response(404, {
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    const resolved = pkg;

    try {
        const operation = start(
            kind,
            resolved.language,
            resolved.version.raw,
            log =>
                kind === 'install'
                    ? resolved.install(log)
                    : resolved.uninstall()
        );
        return json_response(202, operation.view);
    } catch (e) {
        // Only thrown when the same package already has work in flight.
        return json_response(409, { message: error_message(e) });
    }
}

export function handle_list_operations(): Response {
    return json_response(200, list_operations());
}

export function handle_get_operation(id: string): Response {
    const operation = get_operation(id);
    if (!operation) {
        return json_response(404, { message: `Unknown operation ${id}` });
    }
    return json_response(200, operation.view);
}

export function handle_operation_log(id: string): Response {
    const operation = get_operation(id);
    if (!operation) {
        return json_response(404, { message: `Unknown operation ${id}` });
    }
    return new Response(operation.log, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}

// -------------------------------------------------------------- websocket

/** Per-connection state. Bun's websocket handlers are global, so this lives on ws.data. */
export interface JobConnectionData {
    kind: 'job';
    job: Job | null;
    event_bus: JobEventBus;
    init_timer: ReturnType<typeof setTimeout> | null;
}

/**
 * State for a socket watching a package operation. A separate endpoint rather
 * than new message types on /api/v2/connect: the job protocol is frozen, and
 * teaching it a second vocabulary would change what that endpoint accepts.
 */
export interface OperationConnectionData {
    kind: 'operation';
    operation: Operation;
    detach: (() => void) | null;
}

export type ConnectionData = JobConnectionData | OperationConnectionData;

export function new_connection_data(): JobConnectionData {
    return {
        kind: 'job',
        job: null,
        event_bus: new_job_event_bus(),
        init_timer: null,
    };
}

export function new_operation_connection_data(
    operation: Operation
): OperationConnectionData {
    return { kind: 'operation', operation, detach: null };
}

type Socket = ServerWebSocket<ConnectionData>;
type OperationSocket = ServerWebSocket<OperationConnectionData>;

const WS_OPEN = 1;

/**
 * A job outlives the socket that started it, so anything it emits after the
 * client is gone has nowhere to go.
 */
function send(ws: Socket, payload: ServerMessage): void {
    if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

/** Closes with a documented code and its paired reason string. */
function close(ws: Socket, code: CloseCode): void {
    ws.close(code, CLOSE_REASONS[code]);
}

/** Streams an operation's log to a watcher, then closes when it settles. */
const operation_socket = {
    open(ws: OperationSocket) {
        const state = ws.data;
        const { operation } = state;

        // Replay what already happened, so a watcher that attaches late still
        // sees the whole log rather than only the tail.
        const backlog = operation.log;
        if (backlog.length) {
            send_raw(ws, { type: 'log', data: backlog });
        }

        const on_log = (line: string) =>
            send_raw(ws, { type: 'log', data: line });
        const on_state = (op_state: string, error?: string) => {
            send_raw(ws, {
                type: 'state',
                state: op_state,
                ...(error === undefined ? {} : { error }),
            });
            ws.close(1000, 'Operation finished');
        };

        if (operation.state !== 'running') {
            on_state(operation.state, operation.error);
            return;
        }

        operation.events.on('log', on_log);
        operation.events.on('state', on_state);
        state.detach = () => {
            operation.events.off('log', on_log);
            operation.events.off('state', on_state);
        };
    },

    close(ws: OperationSocket) {
        ws.data.detach?.();
        ws.data.detach = null;
    },
};

/** Untyped sibling of `send` for the operation protocol, which is not ServerMessage. */
function send_raw(ws: Socket, payload: Record<string, unknown>): void {
    if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

export const websocket_handlers = {
    open(ws: Socket) {
        if (ws.data.kind === 'operation') {
            operation_socket.open(ws as OperationSocket);
            return;
        }
        const state = ws.data;

        state.event_bus.on('stdout', data =>
            send(ws, { type: 'data', stream: 'stdout', data: data.toString() })
        );
        state.event_bus.on('stderr', data =>
            send(ws, { type: 'data', stream: 'stderr', data: data.toString() })
        );
        state.event_bus.on('stage', stage =>
            send(ws, { type: 'stage', stage })
        );
        state.event_bus.on('exit', (stage, status) =>
            send(ws, { type: 'exit', stage, ...status })
        );

        state.init_timer = setTimeout(() => {
            //Terminate the socket after 1 second, if not initialized.
            if (state.job === null) {
                close(ws, CLOSE_CODES.INITIALIZATION_TIMEOUT);
            }
        }, 1000);
    },

    async message(ws: Socket, raw: string | Buffer) {
        // The operation socket is read-only; anything a watcher sends is ignored.
        if (ws.data.kind === 'operation') return;
        const state = ws.data;

        try {
            const msg = as_client_message(
                JSON.parse(typeof raw === 'string' ? raw : raw.toString())
            );
            // A payload that is not a message at all is ignored, as are types
            // the server does not handle. Closing on either would be breaking.
            if (msg === null) return;

            switch (msg.type) {
                case 'init':
                    if (state.job === null) {
                        const job = get_job(msg);
                        state.job = job;

                        try {
                            const box = await job.prime();

                            send(ws, {
                                type: 'runtime',
                                language: job.runtime.language,
                                version: job.runtime.version.raw,
                                runtime: job.runtime.runtime,
                            });

                            await job.execute(box, state.event_bus);
                        } catch (error) {
                            logger.error(
                                `Error cleaning up job: ${job.uuid}:\n${error}`
                            );
                            throw error;
                        } finally {
                            await job.cleanup();
                        }
                        // Will not execute if an error is thrown above
                        close(ws, CLOSE_CODES.JOB_COMPLETED);
                    } else {
                        close(ws, CLOSE_CODES.ALREADY_INITIALIZED);
                    }
                    break;
                case 'data':
                    if (state.job !== null) {
                        if (msg.stream === 'stdin') {
                            state.event_bus.emit('stdin', String(msg.data));
                        } else {
                            close(ws, CLOSE_CODES.ONLY_STDIN_WRITABLE);
                        }
                    } else {
                        close(ws, CLOSE_CODES.NOT_YET_INITIALIZED);
                    }
                    break;
                case 'signal':
                    if (state.job !== null) {
                        if (is_known_signal(msg.signal)) {
                            state.event_bus.emit('signal', msg.signal);
                        } else {
                            close(ws, CLOSE_CODES.INVALID_SIGNAL);
                        }
                    } else {
                        close(ws, CLOSE_CODES.NOT_YET_INITIALIZED);
                    }
                    break;
            }
        } catch (error) {
            send(ws, { type: 'error', message: error_message(error) });
            close(ws, CLOSE_CODES.NOTIFIED_ERROR);
            // ws.close message is limited to 123 characters, so we notify over WS then close.
        }
    },

    close(ws: Socket) {
        if (ws.data.kind === 'operation') {
            operation_socket.close(ws as OperationSocket);
            return;
        }
        const state = ws.data;
        if (state.init_timer !== null) {
            clearTimeout(state.init_timer);
            state.init_timer = null;
        }
        // Kill whatever is still running so the job releases its slot and
        // sandbox now, instead of holding both until it times out on its own
        logger.debug('WebSocket closed, killing any in-flight stage');
        state.event_bus.emit('signal', 'SIGKILL');
    },
};
