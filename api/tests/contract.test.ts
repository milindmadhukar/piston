/**
 * The /api/v2 contract, asserted against a live API.
 *
 * v2 is frozen (CLAUDE.md) - every status code, message string and close code
 * below is part of the public surface. A failure here is a breaking change, not
 * a flaky test.
 *
 * Requires a running piston with the `bash` 5.0.0 test package installed:
 *   PISTON_URL=http://127.0.0.1:2000 bun test tests/contract.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';

const BASE = process.env.PISTON_URL ?? 'http://127.0.0.1:2000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/api/v2/connect';
const LANG = 'bash';
const VERSION = '5.0.0';

beforeAll(async () => {
    let runtimes: { language: string }[];
    try {
        const res = await fetch(`${BASE}/api/v2/runtimes`);
        runtimes = (await res.json()) as { language: string }[];
    } catch (e) {
        throw new Error(
            `Cannot reach the piston API at ${BASE}. Start it with ` +
                `\`docker compose -f docker-compose.dev.yaml up -d api\` first. (${e})`
        );
    }
    if (!runtimes.some(r => r.language === LANG)) {
        throw new Error(
            `The '${LANG}' test runtime is not installed; the contract suite needs it.`
        );
    }
});

// ------------------------------------------------------------------ helpers

const ok_file = { name: 'main.sh', content: 'echo ok' };
const base_req = { language: LANG, version: VERSION, files: [ok_file] };

async function request(
    method: string,
    path: string,
    body: unknown,
    headers?: Record<string, string>
) {
    const res = await fetch(BASE + path, {
        method,
        headers: headers ?? { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return {
        status: res.status,
        content_type: res.headers.get('content-type'),
        body: text.length ? JSON.parse(text) : null,
        text,
    };
}

async function post(
    path: string,
    body: unknown,
    headers?: Record<string, string>
) {
    return request('POST', path, body, headers);
}

async function execute(body: unknown) {
    return post('/api/v2/execute', body);
}

/** Asserts a 400 carrying exactly this message. */
async function expect_400(body: unknown, message: string) {
    const res = await execute(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message });
}

interface WsOutcome {
    messages: Record<string, unknown>[];
    code: number;
    reason: string;
}

/** Drives one websocket connection to its close and reports what happened. */
function ws_case(
    drive: (ws: WebSocket) => void,
    timeout_ms = 20000
): Promise<WsOutcome> {
    return new Promise((resolve, reject) => {
        const messages: Record<string, unknown>[] = [];
        const ws = new WebSocket(WS_URL);
        const timer = setTimeout(() => {
            ws.close();
            reject(new Error('websocket did not close within the timeout'));
        }, timeout_ms);

        ws.addEventListener('message', ev => {
            messages.push(JSON.parse(String(ev.data)));
        });
        ws.addEventListener('close', ev => {
            clearTimeout(timer);
            resolve({ messages, code: ev.code, reason: ev.reason });
        });
        ws.addEventListener('open', () => drive(ws));
    });
}

const init = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'init', ...base_req, ...over });

const sleeper = (seconds: number) => ({
    files: [{ name: 'm.sh', content: `sleep ${seconds}` }],
});

// -------------------------------------------------------------------- tests

describe('routing', () => {
    test('GET / reports the version', async () => {
        const res = await fetch(BASE + '/');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/json; charset=utf-8'
        );
        const body = (await res.json()) as { message: string };
        expect(body.message).toMatch(/^Piston v\d+\.\d+\.\d+$/);
    });

    test('an unknown path is a 404 with a json body', async () => {
        const res = await fetch(BASE + '/definitely-not-a-route');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ message: 'Not Found' });
    });

    test('the wrong method on a real path falls through to 404', async () => {
        const res = await fetch(BASE + '/api/v2/execute');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ message: 'Not Found' });
    });

    test('a plain GET of the websocket path is a 404', async () => {
        const res = await fetch(BASE + '/api/v2/connect');
        expect(res.status).toBe(404);
    });

    test('the content-type gate does not apply outside /api/v2', async () => {
        const res = await post('/', {});
        expect(res.status).toBe(404);
    });

    test('HEAD returns the headers with no body', async () => {
        const res = await fetch(BASE + '/api/v2/runtimes', { method: 'HEAD' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/json; charset=utf-8'
        );
        expect(await res.text()).toBe('');
    });
});

describe('content-type gate', () => {
    test('a missing content-type is a 415', async () => {
        const res = await post('/api/v2/execute', '{}', {});
        expect(res.status).toBe(415);
        expect(res.body).toEqual({
            message: 'requests must be of type application/json',
        });
    });

    test('a non-json content-type is a 415', async () => {
        const res = await post('/api/v2/execute', '{}', {
            'Content-Type': 'text/plain',
        });
        expect(res.status).toBe(415);
    });

    test('malformed json is a 400 carrying a stack, checked before the gate', async () => {
        const res = await post('/api/v2/execute', '{not valid json');
        expect(res.status).toBe(400);
        expect(typeof res.body.stack).toBe('string');
    });
});

describe('execute validation', () => {
    test('language is required as a string', async () => {
        await expect_400({}, 'language is required as a string');
        await expect_400(
            { language: 5, version: VERSION, files: [ok_file] },
            'language is required as a string'
        );
    });

    test('version is required as a string', async () => {
        await expect_400(
            { language: LANG, files: [ok_file] },
            'version is required as a string'
        );
        await expect_400(
            { language: LANG, version: 5, files: [ok_file] },
            'version is required as a string'
        );
    });

    test('files is required as an array', async () => {
        await expect_400(
            { language: LANG, version: VERSION },
            'files is required as an array'
        );
        await expect_400(
            { language: LANG, version: VERSION, files: 'nope' },
            'files is required as an array'
        );
    });

    test('each file needs string content, reported by index', async () => {
        await expect_400(
            { language: LANG, version: VERSION, files: [{ name: 'a.sh' }] },
            'files[0].content is required as a string'
        );
        await expect_400(
            {
                language: LANG,
                version: VERSION,
                files: [ok_file, { name: 'b.sh' }],
            },
            'files[1].content is required as a string'
        );
    });

    test('an unknown runtime names the language and version', async () => {
        await expect_400(
            { language: 'brainfuck', version: '*', files: [ok_file] },
            'brainfuck-* runtime is unknown'
        );
    });

    test('at least one utf8 file is required', async () => {
        await expect_400(
            {
                language: LANG,
                version: VERSION,
                files: [{ name: 'a.bin', content: 'aGk=', encoding: 'base64' }],
            },
            'files must include at least one utf8 encoded file'
        );
    });

    test('a non-numeric constraint is rejected', async () => {
        await expect_400(
            { ...base_req, run_timeout: 'soon' },
            'If specified, run_timeout must be a number'
        );
    });

    test('a constraint above the configured limit is rejected', async () => {
        const res = await execute({ ...base_req, run_timeout: 999_999_999 });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(
            /^run_timeout cannot exceed the configured limit of \d+$/
        );
    });

    test('a negative constraint is rejected', async () => {
        await expect_400(
            { ...base_req, run_timeout: -5 },
            'run_timeout must be non-negative'
        );
    });

    test('a zero constraint is ignored rather than rejected', async () => {
        // `!constraint_value` treats 0 as absent. Long-standing behaviour that
        // clients may rely on, so it is pinned here deliberately.
        const res = await execute({ ...base_req, run_timeout: 0 });
        expect(res.status).toBe(200);
    });
});

describe('execute', () => {
    test('returns the documented run shape', async () => {
        const res = await execute(base_req);
        expect(res.status).toBe(200);
        expect(res.body.language).toBe(LANG);
        expect(res.body.version).toBe(VERSION);
        expect(res.body.run.stdout).toBe('ok\n');
        expect(res.body.run.stderr).toBe('');
        expect(res.body.run.code).toBe(0);
        expect(res.body.run.signal).toBeNull();
        expect(res.body.run.output).toBe('ok\n');
        // present on every run, values vary
        for (const key of ['memory', 'cpu_time', 'wall_time']) {
            expect(res.body.run).toHaveProperty(key);
        }
        expect(res.body.run).toHaveProperty('message');
        expect(res.body.run).toHaveProperty('status');
    });

    test('delivers stdin', async () => {
        const res = await execute({
            ...base_req,
            files: [{ name: 'm.sh', content: 'read x; echo got:$x' }],
            stdin: 'world',
        });
        expect(res.body.run.stdout).toBe('got:world\n');
    });

    test('passes args through', async () => {
        const res = await execute({
            ...base_req,
            files: [{ name: 'm.sh', content: 'echo "args:$@"' }],
            args: ['a', 'b'],
        });
        expect(res.body.run.stdout).toBe('args:a b\n');
    });

    test('reports a non-zero exit code and stderr', async () => {
        const res = await execute({
            ...base_req,
            files: [{ name: 'm.sh', content: 'echo e >&2; exit 3' }],
        });
        expect(res.body.run.code).toBe(3);
        expect(res.body.run.stderr).toBe('e\n');
        expect(res.body.run.status).toBe('RE');
    });

    test('resolves an alias', async () => {
        const res = await execute({ ...base_req, language: 'sh' });
        expect(res.status).toBe(200);
        expect(res.body.language).toBe(LANG);
    });

    test('resolves a semver range', async () => {
        const res = await execute({ ...base_req, version: '*' });
        expect(res.status).toBe(200);
    });

    test('a wall-clock timeout reports SIGKILL and status TO', async () => {
        const res = await execute({
            ...base_req,
            ...sleeper(10),
            run_timeout: 500,
        });
        expect(res.status).toBe(200);
        expect(res.body.run.status).toBe('TO');
        expect(res.body.run.signal).toBe('SIGKILL');
    });

    test('exceeding the output limit reports SIGKILL and status OL', async () => {
        const res = await execute({
            ...base_req,
            files: [
                { name: 'm.sh', content: 'yes abcdefghij | head -c 100000' },
            ],
        });
        expect(res.body.run.signal).toBe('SIGKILL');
        expect(res.body.run.message).toBe('stdout length exceeded');
    });

    test('an empty files array is rejected, not crashed on', async () => {
        await expect_400(
            { ...base_req, files: [] },
            'files must include at least one utf8 encoded file'
        );
    });

    test('OPTIONS is exempt from the gate and falls through to 404', async () => {
        // The 415 gate skips GET/HEAD/OPTIONS, and no OPTIONS route exists,
        // so it lands on the app-level 404 rather than a 415 or a 200.
        const res = await fetch(BASE + '/api/v2/execute', {
            method: 'OPTIONS',
        });
        expect(res.status).toBe(404);
    });

    test('a file escaping the submission directory is refused', async () => {
        // The guard throws inside prime(), which surfaces as a 500 with an
        // empty body. Pinned because it is observable, not because it is ideal.
        const res = await execute({
            ...base_req,
            files: [{ name: '../escape.sh', content: 'echo nope' }],
        });
        expect(res.status).toBe(500);
        expect(res.text).toBe('');
    });
});

/**
 * A language served by several engines - javascript by node, deno and bun -
 * resolves by version number alone, so the only way a caller can tell which one
 * ran is for the instance to say. `runtime` is that answer, and it is set only
 * for a package declaring `provides:`: absent means "one engine, no ambiguity",
 * which is also what every instance older than the field reports.
 *
 * Skipped rather than failed when nothing multi-engine is installed - the
 * contract suite's own runtime, bash, is deliberately not one.
 */
describe('multi-engine languages', () => {
    async function multi_engine() {
        const res = await fetch(BASE + '/api/v2/runtimes');
        const body = (await res.json()) as {
            language: string;
            version: string;
            runtime?: string;
        }[];
        return body.find(r => r.runtime);
    }

    test('execute names the engine that ran the job', async () => {
        const rt = await multi_engine();
        if (!rt) return;

        const res = await execute({
            language: rt.language,
            version: rt.version,
            files: [{ content: '' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.language).toBe(rt.language);
        expect(res.body.runtime).toBe(rt.runtime);
    });

    test('the websocket runtime frame names it too', async () => {
        const rt = await multi_engine();
        if (!rt) return;

        const out = await ws_case(ws =>
            ws.send(
                init({
                    language: rt.language,
                    version: rt.version,
                    files: [{ content: '' }],
                })
            )
        );
        expect(out.messages[0]).toEqual({
            type: 'runtime',
            language: rt.language,
            version: rt.version,
            runtime: rt.runtime,
        });
    });

    test('a single-engine language reports no runtime at all', async () => {
        const res = await execute(base_req);
        expect(res.status).toBe(200);
        expect('runtime' in res.body).toBe(false);
    });
});

describe('runtimes and packages', () => {
    test('GET /runtimes lists the installed runtime', async () => {
        const res = await fetch(BASE + '/api/v2/runtimes');
        const body = (await res.json()) as {
            language: string;
            version: string;
            aliases: string[];
        }[];
        expect(res.status).toBe(200);
        const bash = body.find(r => r.language === LANG);
        expect(bash).toBeDefined();
        expect(bash?.version).toBe(VERSION);
        expect(Array.isArray(bash?.aliases)).toBe(true);
    });

    // These hold whether or not the package index is reachable: they never get
    // as far as resolving a package.
    test('POST /packages without a content-type is a 415', async () => {
        const res = await post('/api/v2/packages', '{}', {});
        expect(res.status).toBe(415);
        expect(res.body).toEqual({
            message: 'requests must be of type application/json',
        });
    });

    test('POST /packages with malformed json is a 400 carrying a stack', async () => {
        const res = await post('/api/v2/packages', '{not valid json');
        expect(res.status).toBe(400);
        expect(typeof res.body.stack).toBe('string');
    });

    test('DELETE /packages without a content-type is a 415', async () => {
        const res = await request('DELETE', '/api/v2/packages', '{}', {});
        expect(res.status).toBe(415);
    });

    test('an unsupported method on /packages falls through to 404', async () => {
        const res = await request('PATCH', '/api/v2/packages', {});
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Not Found' });
    });
});

/**
 * The rest of the packages surface needs a reachable index - without one every
 * request resolves to a 500 instead of the documented shape. Skipped rather
 * than failed so the suite still runs against an instance with no index.
 */
const packages_probe = await fetch(BASE + '/api/v2/packages')
    .then(async r => r.ok && Array.isArray(await r.json()))
    .catch(() => false);

describe.skipIf(!packages_probe)('packages index', () => {
    test('GET /packages lists packages with exactly the documented fields', async () => {
        const res = await fetch(BASE + '/api/v2/packages');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/json; charset=utf-8'
        );

        const body = (await res.json()) as Record<string, unknown>[];
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBeGreaterThan(0);

        for (const entry of body) {
            // The exact key set is the contract - no more, no less.
            expect(Object.keys(entry).sort()).toEqual([
                'installed',
                'language',
                'language_version',
            ]);
            expect(typeof entry.language).toBe('string');
            expect(typeof entry.language_version).toBe('string');
            expect(typeof entry.installed).toBe('boolean');
        }
    });

    test('HEAD /packages returns the headers with no body', async () => {
        const res = await fetch(BASE + '/api/v2/packages', { method: 'HEAD' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/json; charset=utf-8'
        );
        expect(await res.text()).toBe('');
    });

    test('installing an unknown package is a 404 naming it', async () => {
        const res = await post('/api/v2/packages', {
            language: 'definitely-not-a-language',
            version: '1.0.0',
        });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            message:
                'Requested package definitely-not-a-language-1.0.0 does not exist',
        });
    });

    test('uninstalling an unknown package is the same 404', async () => {
        const res = await request('DELETE', '/api/v2/packages', {
            language: 'definitely-not-a-language',
            version: '1.0.0',
        });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            message:
                'Requested package definitely-not-a-language-1.0.0 does not exist',
        });
    });

    test('a request with no language or version is a 404 naming undefined', async () => {
        // The message interpolates the raw body values, so both read
        // "undefined". Pinned because clients may match on it.
        const res = await post('/api/v2/packages', {});
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            message: 'Requested package undefined-undefined does not exist',
        });
    });

    test('uninstalling a known but uninstalled package is a 500 saying so', async () => {
        const listed = (await (
            await fetch(BASE + '/api/v2/packages')
        ).json()) as {
            language: string;
            language_version: string;
            installed: boolean;
        }[];
        const absent = listed.find(p => !p.installed);
        if (!absent) return; // everything in the index is installed

        const res = await request('DELETE', '/api/v2/packages', {
            language: absent.language,
            version: absent.language_version,
        });
        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            message: `${absent.language}-${absent.language_version} is not installed`,
        });
    });
});

describe('websocket lifecycle', () => {
    test('a successful run emits runtime, stage, data, exit then closes 4999', async () => {
        const out = await ws_case(ws => ws.send(init()));
        expect(out.code).toBe(4999);
        expect(out.reason).toBe('Job Completed');
        expect(out.messages.map(m => m.type)).toEqual([
            'runtime',
            'stage',
            'data',
            'exit',
        ]);
        expect(out.messages[0]).toEqual({
            type: 'runtime',
            language: LANG,
            version: VERSION,
        });
        expect(out.messages[1]).toEqual({ type: 'stage', stage: 'run' });
        expect(out.messages[2]).toEqual({
            type: 'data',
            stream: 'stdout',
            data: 'ok\n',
        });
        expect(out.messages[3]).toEqual({
            type: 'exit',
            stage: 'run',
            code: 0,
            signal: null,
        });
    });

    test('stdin sent over the socket reaches the program', async () => {
        const out = await ws_case(ws => {
            ws.send(
                init({
                    files: [{ name: 'm.sh', content: 'read x; echo got:$x' }],
                })
            );
            setTimeout(
                () =>
                    ws.send(
                        JSON.stringify({
                            type: 'data',
                            stream: 'stdin',
                            data: 'world\n',
                        })
                    ),
                600
            );
        });
        expect(out.code).toBe(4999);
        const data = out.messages.filter(m => m.type === 'data');
        expect(data.map(d => d.data).join('')).toBe('got:world\n');
    });
});

describe('websocket close codes', () => {
    test('4000 when init is sent twice', async () => {
        const out = await ws_case(ws => {
            ws.send(init(sleeper(2)));
            setTimeout(() => ws.send(init()), 200);
        });
        expect(out.code).toBe(4000);
        expect(out.reason).toBe('Already Initialized');
    });

    test('4001 when the client never initialises', async () => {
        const out = await ws_case(() => {});
        expect(out.code).toBe(4001);
        expect(out.reason).toBe('Initialization Timeout');
    });

    test('4002 after an error is notified over the socket', async () => {
        const out = await ws_case(ws => ws.send('this is not json'));
        expect(out.code).toBe(4002);
        expect(out.reason).toBe('Notified Error');
        expect(out.messages).toHaveLength(1);
        expect(out.messages[0]?.type).toBe('error');
        expect(typeof out.messages[0]?.message).toBe('string');
    });

    test('4003 when data arrives before init', async () => {
        const out = await ws_case(ws =>
            ws.send(
                JSON.stringify({ type: 'data', stream: 'stdin', data: 'x' })
            )
        );
        expect(out.code).toBe(4003);
        expect(out.reason).toBe('Not yet initialized');
    });

    test('4003 when a signal arrives before init', async () => {
        const out = await ws_case(ws =>
            ws.send(JSON.stringify({ type: 'signal', signal: 'SIGKILL' }))
        );
        expect(out.code).toBe(4003);
    });

    test('4004 when writing to a stream other than stdin', async () => {
        const out = await ws_case(ws => {
            ws.send(init(sleeper(2)));
            setTimeout(
                () =>
                    ws.send(
                        JSON.stringify({
                            type: 'data',
                            stream: 'stdout',
                            data: 'x',
                        })
                    ),
                300
            );
        });
        expect(out.code).toBe(4004);
        expect(out.reason).toBe('Can only write to stdin');
    });

    test('4005 for a signal name the API does not know', async () => {
        const out = await ws_case(ws => {
            ws.send(init(sleeper(2)));
            setTimeout(
                () =>
                    ws.send(
                        JSON.stringify({
                            type: 'signal',
                            signal: 'SIGNOTAREALONE',
                        })
                    ),
                300
            );
        });
        expect(out.code).toBe(4005);
        expect(out.reason).toBe('Invalid signal');
    });
});

describe('websocket error surfacing', () => {
    // Anything thrown inside the message handler reaches the client as an
    // `error` message before the 4002. That makes these internal throw messages
    // part of the public contract on this path - do not reword them.
    test('a validation failure surfaces as an error message, not a 400', async () => {
        const out = await ws_case(ws =>
            ws.send(
                JSON.stringify({ type: 'init', version: VERSION, files: [] })
            )
        );
        expect(out.code).toBe(4002);
        expect(out.messages).toEqual([
            { type: 'error', message: 'language is required as a string' },
        ]);
    });

    test('an empty files array surfaces its validation message', async () => {
        const out = await ws_case(ws => ws.send(init({ files: [] })));
        expect(out.code).toBe(4002);
        expect(out.messages[0]?.message).toBe(
            'files must include at least one utf8 encoded file'
        );
    });

    test('the path-escape message reaches the client verbatim', async () => {
        const out = await ws_case(ws =>
            ws.send(
                init({
                    files: [{ name: '../escape.sh', content: 'echo nope' }],
                })
            )
        );
        expect(out.code).toBe(4002);
        expect(out.messages[0]?.message).toBe(
            'File path "../escape.sh" tries to escape parent directory: ../escape.sh'
        );
    });

    test('an unrecognised message type is ignored, not closed on', async () => {
        // The switch has no default. Adding strict inbound validation must not
        // start rejecting these - that would be a breaking change.
        const out = await ws_case(ws =>
            ws.send(JSON.stringify({ type: 'nonsense', whatever: 1 }))
        );
        expect(out.code).toBe(4001); // closed by the init timeout, nothing else
        expect(out.messages).toEqual([]);
    });
});

describe('signal handling invariants', () => {
    test('a delivered signal kills the stage and is reported on exit', async () => {
        const out = await ws_case(ws => {
            ws.send(init(sleeper(10)));
            setTimeout(
                () =>
                    ws.send(
                        JSON.stringify({ type: 'signal', signal: 'SIGKILL' })
                    ),
                800
            );
        });
        expect(out.code).toBe(4999);
        const exit = out.messages.find(m => m.type === 'exit');
        expect(exit?.signal).toBe('SIGKILL');
    });

    test('a stop signal is accepted but never delivered', async () => {
        // Forwarding SIGSTOP would suspend isolate itself, leaving the sandboxed
        // program running with nothing enforcing its limits, and the job would
        // hold its slot forever. It must be accepted (not 4005) and dropped.
        const out = await ws_case(ws => {
            ws.send(
                init({
                    files: [{ name: 'm.sh', content: 'sleep 1; echo done' }],
                })
            );
            setTimeout(
                () =>
                    ws.send(
                        JSON.stringify({ type: 'signal', signal: 'SIGSTOP' })
                    ),
                300
            );
        });
        expect(out.code).toBe(4999);
        const data = out.messages.filter(m => m.type === 'data');
        expect(data.map(d => d.data).join('')).toBe('done\n');
    });

    test('a realtime signal Node cannot name does not take the job down', async () => {
        // proc.kill throws for SIGRTMIN+n; the throw must be swallowed.
        const out = await ws_case(ws => {
            ws.send(
                init({
                    files: [{ name: 'm.sh', content: 'sleep 1; echo done' }],
                })
            );
            setTimeout(
                () =>
                    ws.send(
                        JSON.stringify({
                            type: 'signal',
                            signal: 'SIGRTMIN+1',
                        })
                    ),
                300
            );
        });
        expect(out.code).toBe(4999);
        const data = out.messages.filter(m => m.type === 'data');
        expect(data.map(d => d.data).join('')).toBe('done\n');
    });
});

describe('job slot release', () => {
    test('closing the socket mid-run frees the slot for the next job', async () => {
        // A job that outlives its socket would hold remaining_job_spaces
        // forever. Closing mid-run must kill the stage and return the slot.
        const ws = new WebSocket(WS_URL);
        await new Promise<void>(resolve => {
            ws.addEventListener('open', () => {
                ws.send(init(sleeper(30)));
                setTimeout(() => {
                    ws.close();
                    resolve();
                }, 800);
            });
        });

        // If the slot leaked, this would block until the abandoned job timed out.
        const started = Date.now();
        const res = await execute(base_req);
        expect(res.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test('the API still serves after all of the above', async () => {
        const res = await fetch(BASE + '/');
        expect(res.status).toBe(200);
    });
});
