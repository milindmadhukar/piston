import cp from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

import config from './config.ts';
import { create, type Logger } from './logger.ts';
import { error_message } from './errors.ts';
import {
    is_known_signal,
    signal_for_code,
    type SignalName,
} from './globals.ts';
import { JobSlots } from './job_slots.ts';
import { TypedEmitter } from './typed_emitter.ts';
import type { ExitStatus, JobStatus, Stage } from './protocol.ts';
import type { Runtime, StageLimits } from './runtime.ts';

/** Where a job is in its lifecycle. */
export type JobState = 'ready' | 'primed' | 'executed';

const MAX_BOX_ID = 999;
const ISOLATE_PATH = '/usr/local/bin/isolate';
// Signals whose default action stops a process. Forwarding one of these would
// suspend the isolate process itself, leaving the sandboxed program running with
// nothing left to enforce its limits, so they are accepted but never delivered.
const STOP_SIGNALS: readonly SignalName[] = [
    'SIGSTOP',
    'SIGTSTP',
    'SIGTTIN',
    'SIGTTOU',
];

let box_id = 0;
const get_next_box_id = () => ++box_id % MAX_BOX_ID;

export const job_slots = new JobSlots(config.max_concurrent_jobs);

/**
 * Events crossing the boundary between a running job and the WebSocket that
 * started it. `stdin` and `signal` flow inward from the client; the rest flow
 * outward to it.
 */
export interface JobEvents {
    stdout: [Buffer];
    stderr: [Buffer];
    stage: [Stage];
    exit: [Stage, ExitStatus];
    stdin: [string];
    signal: [SignalName];
}

export type JobEventBus = TypedEmitter<JobEvents>;

export function new_job_event_bus(): JobEventBus {
    return new TypedEmitter<JobEvents>();
}

/** A submitted file, after defaulting is applied. */
export interface JobFile {
    name: string;
    content: string;
    encoding: BufferEncoding;
}

/** A file as it arrives from the client, before defaulting. */
export interface SubmittedFile {
    name?: string;
    content: string;
    encoding?: string;
}

/** An isolate sandbox allocated to this job. */
export interface IsolateBox {
    id: number;
    metadata_file_path: string;
    dir: string;
}

/** The per-stage result reported by /api/v2/execute and the `exit` WS message. */
export interface StageResult {
    signal: SignalName | null;
    stdout: string;
    stderr: string;
    code: number | null;
    output: string;
    memory: number | null;
    message: string | null;
    status: JobStatus | null;
    cpu_time: number | null;
    wall_time: number | null;
}

export interface ExecuteResult {
    compile?: StageResult;
    run?: StageResult;
    language: string;
    version: string;
}

export interface JobOptions {
    runtime: Runtime;
    files: SubmittedFile[];
    args: string[];
    stdin: string;
    timeouts: StageLimits;
    cpu_times: StageLimits;
    memory_limits: StageLimits;
}

const VALID_ENCODINGS: readonly BufferEncoding[] = ['base64', 'hex', 'utf8'];

function is_valid_encoding(e: string | undefined): e is BufferEncoding {
    return VALID_ENCODINGS.includes(e as BufferEncoding);
}

/** Statuses whose signal is reported as SIGKILL regardless of how it died. */
const KILLED_STATUSES: readonly JobStatus[] = ['TO', 'OL', 'EL'];

/**
 * Where a job reports stage transitions and results.
 *
 * The non-interactive path has nowhere to send these, so it uses the null
 * implementation rather than branching at every call site.
 */
interface StageReporter {
    stage_started(stage: Stage): void;
    stage_finished(stage: Stage, result: StageResult): void;
}

const SILENT_REPORTER: StageReporter = {
    stage_started() {},
    stage_finished() {},
};

function bus_reporter(bus: JobEventBus): StageReporter {
    return {
        stage_started: stage => bus.emit('stage', stage),
        stage_finished: (stage, { code, signal }) =>
            bus.emit('exit', stage, { code, signal }),
    };
}

export class Job {
    #dirty_boxes: IsolateBox[] = [];

    readonly uuid: string;
    readonly logger: Logger;
    readonly runtime: Runtime;
    readonly files: JobFile[];
    readonly args: string[];
    stdin: string;
    readonly timeouts: StageLimits;
    readonly cpu_times: StageLimits;
    readonly memory_limits: StageLimits;
    state: JobState;

    constructor({
        runtime,
        files,
        args,
        stdin,
        timeouts,
        cpu_times,
        memory_limits,
    }: JobOptions) {
        this.uuid = crypto.randomUUID();

        this.logger = create(`job/${this.uuid}`);

        this.runtime = runtime;
        this.files = files.map((file, i) => ({
            name: file.name || `file${i}.code`,
            content: file.content,
            encoding: is_valid_encoding(file.encoding) ? file.encoding : 'utf8',
        }));

        this.args = args;
        this.stdin = stdin;
        // Add a trailing newline if it doesn't exist
        if (this.stdin.slice(-1) !== '\n') {
            this.stdin += '\n';
        }

        this.timeouts = timeouts;
        this.cpu_times = cpu_times;
        this.memory_limits = memory_limits;

        this.state = 'ready';
    }

    async #create_isolate_box(): Promise<IsolateBox> {
        const box_id = get_next_box_id();
        const metadata_file_path = `/tmp/${box_id}-metadata.txt`;
        return new Promise((res, rej) => {
            cp.exec(
                `isolate --init --cg -b${box_id}`,
                (error, stdout, stderr) => {
                    if (error) {
                        rej(
                            `Failed to run isolate --init: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`
                        );
                    }
                    if (stdout === '') {
                        rej('Received empty stdout from isolate --init');
                    }
                    const box: IsolateBox = {
                        id: box_id,
                        metadata_file_path,
                        dir: `${stdout.trim()}/box`,
                    };
                    this.#dirty_boxes.push(box);
                    res(box);
                }
            );
        });
    }

    async prime(): Promise<IsolateBox> {
        if (job_slots.available < 1) {
            this.logger.info(`Awaiting job slot`);
        }
        await job_slots.acquire();

        this.logger.info(`Priming job`);
        this.logger.debug('Running isolate --init');
        const box = await this.#create_isolate_box();

        this.logger.debug(`Creating submission files in Isolate box`);
        const submission_dir = path.join(box.dir, 'submission');
        await fs.mkdir(submission_dir);
        for (const file of this.files) {
            const file_path = path.join(submission_dir, file.name);
            const rel = path.relative(submission_dir, file_path);

            if (rel.startsWith('..'))
                throw Error(
                    `File path "${file.name}" tries to escape parent directory: ${rel}`
                );

            const file_content = Buffer.from(file.content, file.encoding);

            await fs.mkdir(path.dirname(file_path), {
                recursive: true,
                mode: 0o700,
            });
            await fs.writeFile(file_path, file_content);
        }

        this.state = 'primed';

        this.logger.debug('Primed job');
        return box;
    }

    /** Builds the isolate argv for one stage. */
    #isolate_args(
        box: IsolateBox,
        file: string,
        args: string[],
        timeout: number,
        cpu_time: number,
        memory_limit: number
    ): string[] {
        return [
            '--run',
            `-b${box.id}`,
            `--meta=${box.metadata_file_path}`,
            '--cg',
            '-s',
            '-c',
            '/box/submission',
            '-E',
            'HOME=/tmp',
            ...this.runtime.env_vars.flatMap(v => ['-E', v]),
            '-E',
            `PISTON_LANGUAGE=${this.runtime.language}`,
            `--dir=${this.runtime.pkgdir}`,
            `--dir=/etc:noexec`,
            `--processes=${this.runtime.max_process_count}`,
            `--open-files=${this.runtime.max_open_files}`,
            `--fsize=${Math.floor(this.runtime.max_file_size / 1000)}`,
            `--wall-time=${timeout / 1000}`,
            `--time=${cpu_time / 1000}`,
            `--extra-time=0`,
            ...(memory_limit >= 0
                ? [`--cg-mem=${Math.floor(memory_limit / 1000)}`]
                : []),
            ...(config.disable_networking ? [] : ['--share-net']),
            '--',
            '/bin/bash',
            path.join(this.runtime.pkgdir, file),
            ...args,
        ];
    }

    async safe_call(
        box: IsolateBox,
        file: string,
        args: string[],
        timeout: number,
        cpu_time: number,
        memory_limit: number,
        event_bus: JobEventBus | null = null
    ): Promise<StageResult> {
        let stdout = '';
        let stderr = '';
        let output = '';
        let memory: number | null = null;
        let code: number | null = null;
        let signal: SignalName | null = null;
        let message: string | null = null;
        let status: JobStatus | null = null;
        let cpu_time_stat: number | null = null;
        let wall_time_stat: number | null = null;
        let killed_by_signal: SignalName | null = null;
        let stdin_handler: ((data: string) => void) | null = null;
        let signal_handler: ((signal: SignalName) => void) | null = null;

        const proc = cp.spawn(
            ISOLATE_PATH,
            this.#isolate_args(
                box,
                file,
                args,
                timeout,
                cpu_time,
                memory_limit
            ),
            { stdio: 'pipe' }
        );

        proc.stdin.on('error', e => {
            // Writing to a process that has closed its end of the pipe raises
            // EPIPE here, which would take down the API if left unhandled
            this.logger.debug('Got error while writing to stdin:', e);
        });

        /** SIGABRTs the stage when it produces more output than it is allowed. */
        const abort_for_output_limit = (
            limit_message: string,
            limit_status: JobStatus
        ) => {
            message = limit_message;
            status = limit_status;
            this.logger.info(limit_message);
            try {
                if (proc.pid !== undefined) {
                    process.kill(proc.pid, 'SIGABRT');
                }
            } catch (e) {
                // Could already be dead and just needs to be waited on
                this.logger.debug(
                    `Got error while SIGABRTing process ${proc.pid}:`,
                    e
                );
            }
        };

        if (event_bus === null) {
            proc.stdin.write(this.stdin);
            proc.stdin.end();
            proc.stdin.destroy();
        } else {
            stdin_handler = (data: string) => {
                proc.stdin.write(data);
            };

            signal_handler = (signal: SignalName) => {
                if (STOP_SIGNALS.includes(signal)) {
                    this.logger.debug(`Ignoring stop signal ${signal}`);
                    return;
                }
                try {
                    // SignalName includes SIGRTMIN+n, which Node has no constant
                    // for and rejects. Passing it through and catching is the
                    // point: the client may send any accepted signal name.
                    if (proc.kill(signal as NodeJS.Signals)) {
                        killed_by_signal = signal;
                    }
                } catch (e) {
                    // Could already be dead, or be a signal Node has no name for
                    // (SIGRTMIN+n); neither should take down the job
                    this.logger.debug(
                        `Got error while sending ${signal} to process ${proc.pid}:`,
                        e
                    );
                }
            };

            event_bus.on('stdin', stdin_handler);
            event_bus.on('signal', signal_handler);
        }

        proc.stderr.on('data', (data: Buffer) => {
            if (event_bus !== null) {
                event_bus.emit('stderr', data);
            } else if (
                stderr.length + data.length >
                this.runtime.output_max_size
            ) {
                abort_for_output_limit('stderr length exceeded', 'EL');
            } else {
                stderr += data;
                output += data;
            }
        });

        proc.stdout.on('data', (data: Buffer) => {
            if (event_bus !== null) {
                event_bus.emit('stdout', data);
            } else if (
                stdout.length + data.length >
                this.runtime.output_max_size
            ) {
                abort_for_output_limit('stdout length exceeded', 'OL');
            } else {
                stdout += data;
                output += data;
            }
        });

        let exit_signal: NodeJS.Signals | null;
        try {
            exit_signal = await new Promise((res, rej) => {
                proc.on('exit', (_, signal) => res(signal));
                proc.on('error', err => rej(err));
            });
        } finally {
            // safe_call runs once per stage against a shared event bus, so the
            // handlers have to go when the stage does
            if (event_bus !== null) {
                if (stdin_handler) event_bus.off('stdin', stdin_handler);
                if (signal_handler) event_bus.off('signal', signal_handler);
            }
        }

        try {
            const metadata_str = (
                await fs.readFile(box.metadata_file_path)
            ).toString();
            for (const line of metadata_str.split('\n')) {
                if (!line) continue;

                const [key, value] = line.split(':');
                if (key === undefined || value === undefined) {
                    throw new Error(
                        `Failed to parse metadata file, received: ${line}`
                    );
                }
                switch (key) {
                    case 'cg-mem':
                        memory = parseInt(value) * 1000;
                        break;
                    case 'exitcode':
                        code = parseInt(value);
                        break;
                    case 'exitsig':
                        signal = signal_for_code(parseInt(value));
                        break;
                    case 'message':
                        message = message || value;
                        break;
                    case 'status':
                        status = status || value;
                        break;
                    case 'time':
                        cpu_time_stat = parseFloat(value) * 1000;
                        break;
                    case 'time-wall':
                        wall_time_stat = parseFloat(value) * 1000;
                        break;
                    default:
                        break;
                }
            }
        } catch (e) {
            if (killed_by_signal === null) {
                throw new Error(
                    `Error reading metadata file: ${box.metadata_file_path}\nError: ${error_message(e)}\nIsolate run stdout: ${stdout}\nIsolate run stderr: ${stderr}`
                );
            }
            // A signal the isolate process cannot catch, SIGKILL in particular,
            // takes it out before it writes its metadata file. Fall through and
            // report the signal instead of failing the whole job.
            this.logger.debug(
                `Missing metadata file after sending ${killed_by_signal}: ${error_message(e)}`
            );
        }

        if (killed_by_signal !== null && code === null && signal === null) {
            // Isolate was signalled by the client and went down without
            // recording an exit status, so report what we know instead of
            // leaving the client with no reason for the job ending.
            //
            // Node's signal names are checked rather than cast: the two sets
            // differ only in aliases (SIGIOT, SIGPOLL) and names Linux does not
            // deliver, none of which can reach this branch, so in practice this
            // always takes the first arm.
            signal = is_known_signal(exit_signal)
                ? exit_signal
                : killed_by_signal;
            status = status ?? 'SG';
            message = message ?? `Killed by ${killed_by_signal}`;
        }

        return {
            // `signal` is first because the original spread the exit-event
            // result before the explicit fields, and clients see that key order.
            signal:
                status !== null && KILLED_STATUSES.includes(status)
                    ? 'SIGKILL'
                    : signal,
            stdout,
            stderr,
            code,
            output,
            memory,
            message,
            status,
            cpu_time: cpu_time_stat,
            wall_time: wall_time_stat,
        };
    }

    async execute(
        box: IsolateBox,
        event_bus: JobEventBus | null = null
    ): Promise<ExecuteResult> {
        if (this.state !== 'primed') {
            throw new Error(
                'Job must be in primed state, current state: ' + this.state
            );
        }

        this.logger.info(`Executing job runtime=${this.runtime.toString()}`);

        const code_files =
            (this.runtime.language === 'file' && this.files) ||
            this.files.filter(file => file.encoding == 'utf8');

        const entrypoint = code_files[0];
        if (entrypoint === undefined) {
            throw new Error('No code files to execute');
        }

        const report =
            event_bus === null ? SILENT_REPORTER : bus_reporter(event_bus);

        let compile: StageResult | undefined;
        let compile_errored = false;

        if (this.runtime.compiled) {
            this.logger.debug('Compiling');
            report.stage_started('compile');
            compile = await this.safe_call(
                box,
                'compile',
                code_files.map(x => x.name),
                this.timeouts.compile,
                this.cpu_times.compile,
                this.memory_limits.compile,
                event_bus
            );
            report.stage_finished('compile', compile);
            compile_errored = compile.code !== 0;
            if (!compile_errored) {
                const old_box_dir = box.dir;
                box = await this.#create_isolate_box();
                await fs.rename(
                    path.join(old_box_dir, 'submission'),
                    path.join(box.dir, 'submission')
                );
            }
        }

        let run: StageResult | undefined;
        if (!compile_errored) {
            this.logger.debug('Running');
            report.stage_started('run');
            run = await this.safe_call(
                box,
                'run',
                [entrypoint.name, ...this.args],
                this.timeouts.run,
                this.cpu_times.run,
                this.memory_limits.run,
                event_bus
            );
            report.stage_finished('run', run);
        }

        this.state = 'executed';

        return {
            compile,
            run,
            language: this.runtime.language,
            version: this.runtime.version.raw,
        };
    }

    async cleanup(): Promise<void> {
        this.logger.info(`Cleaning up job`);

        job_slots.release();

        await Promise.all(
            this.#dirty_boxes.map(async box => {
                cp.exec(
                    `isolate --cleanup --cg -b${box.id}`,
                    (error, stdout, stderr) => {
                        if (error) {
                            this.logger.error(
                                `Failed to run isolate --cleanup: ${error.message} on box #${box.id}\nstdout: ${stdout}\nstderr: ${stderr}`
                            );
                        }
                    }
                );
                try {
                    await fs.rm(box.metadata_file_path);
                } catch (e) {
                    this.logger.error(
                        `Failed to remove the metadata directory of box #${box.id}. Error: ${error_message(e)}`
                    );
                }
            })
        );
    }
}
