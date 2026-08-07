#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import process from 'node:process';

import { PistonApi, ApiError } from './api.ts';
import {
    handler as execute_handler,
    usage as execute_usage,
    type ExecuteOptions,
} from './commands/execute.ts';
import * as ppman from './commands/ppman.ts';

const DEFAULT_URL = 'http://127.0.0.1:2000';

const USAGE = `
piston - Piston Execution Engine CLI

Usage: piston [global options] <command> [command options]

Global options:
  -u, --piston-url <url>   Piston API URL   (default: ${DEFAULT_URL})
  -h, --help               Show help
${execute_usage}
${ppman.usage}
`.trimStart();

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    // Anything after the command's own arguments belongs to the executed
    // program, so unknown flags must not be treated as ours.
    strict: false,
    options: {
        'piston-url': { type: 'string', short: 'u' },
        help: { type: 'boolean', short: 'h' },
        language_version: { type: 'string', short: 'l' },
        stdin: { type: 'boolean', short: 'i' },
        run_timeout: { type: 'string', short: 'r' },
        compile_timeout: { type: 'string', short: 'c' },
        files: { type: 'string', short: 'f', multiple: true },
        interactive: { type: 'boolean', short: 't' },
        status: { type: 'boolean', short: 's' },
    },
});

const [command, ...rest] = positionals.map(String);

if (values.help || command === undefined) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
}

const api = new PistonApi(
    typeof values['piston-url'] === 'string'
        ? values['piston-url']
        : DEFAULT_URL
);

/** Parses a numeric flag, falling back to the documented default. */
function number_option(raw: unknown, fallback: number): number {
    if (typeof raw !== 'string') return fallback;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
}

try {
    switch (command) {
        case 'execute':
        case 'run': {
            const [language, file, ...args] = rest;
            if (!language || !file) {
                fail(
                    'execute requires a language and a file\n' + execute_usage
                );
            }

            const options: ExecuteOptions = {
                api,
                language,
                file,
                args,
                language_version:
                    typeof values.language_version === 'string'
                        ? values.language_version
                        : '*',
                stdin: values.stdin === true,
                run_timeout: number_option(values.run_timeout, 3000),
                compile_timeout: number_option(values.compile_timeout, 10000),
                files: Array.isArray(values.files)
                    ? values.files.map(String)
                    : [],
                interactive: values.interactive === true,
                status: values.status === true,
            };

            await execute_handler(options);
            break;
        }

        case 'ppman':
        case 'pkg': {
            const [sub, ...sub_args] = rest;
            switch (sub) {
                case 'list':
                case 'l':
                    await ppman.list(api);
                    break;
                case 'install':
                case 'i':
                    if (sub_args.length === 0)
                        fail('install requires at least one package');
                    await ppman.install(api, sub_args);
                    break;
                case 'uninstall':
                case 'u':
                    if (sub_args.length === 0)
                        fail('uninstall requires at least one package');
                    await ppman.uninstall(api, sub_args);
                    break;
                case 'spec':
                case 's': {
                    const [specfile] = sub_args;
                    if (!specfile) fail('spec requires a specfile');
                    await ppman.spec(api, specfile);
                    break;
                }
                default:
                    fail(
                        `Unknown ppman subcommand: ${sub ?? '(none)'}\n${ppman.usage}`
                    );
            }
            break;
        }

        default:
            fail(`Unknown command: ${command}\n\n${USAGE}`);
    }
} catch (e) {
    if (e instanceof ApiError) {
        fail(e.message);
    }
    // A refused or unreachable API is an ordinary operator error, not a crash;
    // report it without a stack trace.
    if (e instanceof TypeError || (e instanceof Error && 'code' in e)) {
        fail(`Could not reach the piston API at ${api.base_url}: ${e.message}`);
    }
    throw e;
}
