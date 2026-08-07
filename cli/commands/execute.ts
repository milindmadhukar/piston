import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import chalk from 'chalk';

import type { PistonApi } from '../api.ts';
import {
    TRAPPABLE_SIGNALS,
    type ExecuteRequest,
    type ExecuteResponse,
    type ServerMessage,
    type StageResult,
    type SubmittedFile,
} from '../protocol.ts';

export interface ExecuteOptions {
    api: PistonApi;
    language: string;
    file: string;
    args: string[];
    language_version: string;
    stdin: boolean;
    run_timeout: number;
    compile_timeout: number;
    files: string[];
    interactive: boolean;
    status: boolean;
}

export const usage = `
piston execute [options] <language> <file> [args...]
  aliases: run

  -l, --language_version <ver>  Version of the language to use   (default: *)
  -i, --stdin                   Read input from stdin and pass to executor
  -r, --run_timeout <ms>        Milliseconds before killing run     (default: 3000)
  -c, --compile_timeout <ms>    Milliseconds before killing compile (default: 10000)
  -f, --files <path>            Additional file to add (repeatable)
  -t, --interactive             Run interactively using WebSocket transport
  -s, --status                  Output additional status to stderr
`.trimEnd();

/** Reads a file, choosing base64 when it is not valid UTF-8. */
function read_submitted_file(file_path: string): SubmittedFile {
    const buffer = readFileSync(file_path);
    // Checks for U+FFFD (the replacement character) after decoding as utf8
    const encoding: SubmittedFile['encoding'] = buffer
        .toString()
        .split('')
        .some(x => x.charCodeAt(0) === 65533)
        ? 'base64'
        : 'utf8';

    return {
        name: path.basename(file_path),
        content: buffer.toString(encoding),
        encoding,
    };
}

async function read_stdin(): Promise<string> {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

async function handle_interactive(
    files: SubmittedFile[],
    opts: ExecuteOptions
): Promise<void> {
    const log_message =
        process.stderr.isTTY && opts.status
            ? (...parts: unknown[]) => console.error(...parts)
            : () => {};

    const ws = new WebSocket(opts.api.ws_url);

    await new Promise<void>(resolve => {
        const cleanup_and_exit = () => {
            try {
                ws.close();
            } catch {
                /* already closed */
            }
            process.stdin.pause();
            resolve();
        };

        for (const signal of TRAPPABLE_SIGNALS) {
            process.on(signal, () => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'signal', signal }));
                }
            });
        }

        ws.addEventListener('open', () => {
            const request = {
                type: 'init',
                language: opts.language,
                version: opts.language_version,
                files,
                args: opts.args,
                compile_timeout: opts.compile_timeout,
                run_timeout: opts.run_timeout,
            };

            ws.send(JSON.stringify(request));
            log_message(chalk.white.bold('Connected'));

            process.stdin.resume();
            process.stdin.on('data', data => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            type: 'data',
                            stream: 'stdin',
                            data: data.toString(),
                        })
                    );
                }
            });
        });

        ws.addEventListener('close', ev => {
            log_message(
                chalk.white.bold('Disconnected: '),
                chalk.white.bold('Reason: '),
                chalk.yellow(`"${ev.reason}"`),
                chalk.white.bold('Code: '),
                chalk.yellow(`"${ev.code}"`)
            );
            cleanup_and_exit();
        });

        ws.addEventListener('error', () => {
            console.error(chalk.red.bold('WebSocket error'));
            cleanup_and_exit();
        });

        ws.addEventListener('message', ev => {
            const msg: ServerMessage = JSON.parse(String(ev.data));

            switch (msg.type) {
                case 'runtime':
                    log_message(
                        chalk.bold.white('Runtime:'),
                        chalk.yellow(`${msg.language} ${msg.version}`)
                    );
                    break;
                case 'stage':
                    log_message(
                        chalk.bold.white('Stage:'),
                        chalk.yellow(msg.stage)
                    );
                    break;
                case 'data':
                    if (msg.stream === 'stdout') process.stdout.write(msg.data);
                    else if (msg.stream === 'stderr')
                        process.stderr.write(msg.data);
                    else
                        log_message(
                            chalk.bold.red(`(${msg.stream}) `),
                            msg.data
                        );
                    break;
                case 'exit':
                    if (msg.signal === null)
                        log_message(
                            chalk.white.bold('Stage'),
                            chalk.yellow(msg.stage),
                            chalk.white.bold('exited with code'),
                            chalk.yellow(msg.code)
                        );
                    else
                        log_message(
                            chalk.white.bold('Stage'),
                            chalk.yellow(msg.stage),
                            chalk.white.bold('exited with signal'),
                            chalk.yellow(msg.signal)
                        );
                    break;
                case 'error':
                    log_message(chalk.red.bold('Error:'), msg.message);
                    break;
                default:
                    log_message(chalk.red.bold('Unknown message:'), msg);
            }
        });
    });
}

function print_step(name: string, ctx: StageResult): void {
    console.log(chalk.bold(`== ${name} ==`));

    if (ctx.stdout) {
        console.log(chalk.bold(`STDOUT`));
        console.log(ctx.stdout.replace(/\n/g, '\n    '));
    }

    if (ctx.stderr) {
        console.log(chalk.bold(`STDERR`));
        console.log(ctx.stderr.replace(/\n/g, '\n    '));
    }

    if (ctx.code) {
        console.log(
            chalk.bold(`Exit Code:`),
            chalk.bold[ctx.code > 0 ? 'red' : 'green'](ctx.code)
        );
    }

    if (ctx.signal) {
        console.log(chalk.bold(`Signal:`), chalk.bold.yellow(ctx.signal));
    }
}

async function run_non_interactively(
    files: SubmittedFile[],
    opts: ExecuteOptions
): Promise<void> {
    const stdin = opts.stdin ? await read_stdin() : '';

    const request: ExecuteRequest = {
        language: opts.language,
        version: opts.language_version,
        files,
        args: opts.args,
        stdin,
        compile_timeout: opts.compile_timeout,
        run_timeout: opts.run_timeout,
    };

    const response = await opts.api.post<ExecuteResponse>(
        '/api/v2/execute',
        request
    );

    if (response.compile) {
        print_step('Compile', response.compile);
    }

    if (response.run) {
        print_step('Run', response.run);
    }
}

export async function handler(opts: ExecuteOptions): Promise<void> {
    const files = [...opts.files, opts.file].map(read_submitted_file);

    if (opts.interactive) await handle_interactive(files, opts);
    else await run_non_interactively(files, opts);
}
