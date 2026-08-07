/**
 * Captures the observable behaviour of the live /api/v2 surface to a JSON file.
 *
 * This exists because the v2 contract is frozen (see CLAUDE.md) while the HTTP
 * layer underneath it is being rewritten on Bun.serve. Run this against the
 * pre-rewrite build to produce the oracle, then again after the rewrite and
 * diff the two files. Any difference is a contract break.
 *
 *   bun run api/tests/capture_baseline.ts > baseline.json
 *
 * Requires a running API with the `bash` 5.0.0 test package installed.
 */

const BASE = process.env.PISTON_URL ?? 'http://127.0.0.1:2000';
const WS_BASE = BASE.replace(/^http/, 'ws');

type Capture = Record<string, unknown>;
const results: Capture = {};

// ---------------------------------------------------------------- HTTP

async function http(
    name: string,
    path: string,
    init?: RequestInit & { raw_body?: string }
) {
    const opts: RequestInit = { ...init };
    if (init?.raw_body !== undefined) opts.body = init.raw_body;
    try {
        const res = await fetch(BASE + path, opts);
        const text = await res.text();
        let body: unknown = text;
        try {
            body = JSON.parse(text);
        } catch {
            /* keep raw text */
        }
        results[name] = {
            status: res.status,
            content_type: res.headers.get('content-type'),
            body,
        };
    } catch (e) {
        results[name] = { error: String(e) };
    }
}

const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

const ok_file = { name: 'main.sh', content: 'echo ok' };
const base_req = {
    language: 'bash',
    version: '5.0.0',
    files: [ok_file],
};

async function capture_http() {
    await http('root', '/');
    await http('not_found', '/definitely-not-a-route');
    await http('runtimes', '/api/v2/runtimes');

    // 415 gate: any non-GET/HEAD/OPTIONS without a json content-type
    await http('execute_no_content_type', '/api/v2/execute', {
        method: 'POST',
        body: '{}',
    });
    await http('execute_wrong_content_type', '/api/v2/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
    });
    // GET is exempt from the gate
    await http('runtimes_head', '/api/v2/runtimes', { method: 'HEAD' });

    // malformed JSON with a correct content-type is caught by the body parser,
    // not by get_job, and answers 400 with a { stack } body
    await http('malformed_json_body', '/api/v2/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
    });
    // wrong method on a real path falls through to the app-level 404
    await http('execute_wrong_method', '/api/v2/execute');
    await http('connect_over_http', '/api/v2/connect');
    // the 415 gate is mounted on the v2 router only, so POST / is a plain 404
    await http('post_root', '/', json({}));

    // 400 validation branches, one per reject() in get_job
    await http('missing_language', '/api/v2/execute', json({}));
    await http(
        'language_not_string',
        '/api/v2/execute',
        json({ language: 5, version: '5.0.0', files: [ok_file] })
    );
    await http(
        'missing_version',
        '/api/v2/execute',
        json({ language: 'bash', files: [ok_file] })
    );
    await http(
        'version_not_string',
        '/api/v2/execute',
        json({ language: 'bash', version: 5, files: [ok_file] })
    );
    await http(
        'missing_files',
        '/api/v2/execute',
        json({ language: 'bash', version: '5.0.0' })
    );
    await http(
        'files_not_array',
        '/api/v2/execute',
        json({ language: 'bash', version: '5.0.0', files: 'nope' })
    );
    await http(
        'file_content_not_string',
        '/api/v2/execute',
        json({ language: 'bash', version: '5.0.0', files: [{ name: 'a.sh' }] })
    );
    await http(
        'unknown_runtime',
        '/api/v2/execute',
        json({ language: 'brainfuck', version: '*', files: [ok_file] })
    );
    await http(
        'no_utf8_file',
        '/api/v2/execute',
        json({
            language: 'bash',
            version: '5.0.0',
            files: [{ name: 'a.bin', content: 'aGk=', encoding: 'base64' }],
        })
    );
    await http(
        'constraint_not_number',
        '/api/v2/execute',
        json({ ...base_req, run_timeout: 'soon' })
    );
    await http(
        'constraint_exceeds_limit',
        '/api/v2/execute',
        json({ ...base_req, run_timeout: 999_999_999 })
    );
    await http(
        'constraint_negative',
        '/api/v2/execute',
        json({ ...base_req, run_timeout: -5 })
    );
    // 0 is falsy so the guard skips it entirely - documents current behaviour
    await http(
        'constraint_zero',
        '/api/v2/execute',
        json({ ...base_req, run_timeout: 0 })
    );

    // happy paths
    await http('execute_basic', '/api/v2/execute', json(base_req));
    await http(
        'execute_stdin',
        '/api/v2/execute',
        json({
            ...base_req,
            files: [{ name: 'm.sh', content: 'read x; echo got:$x' }],
            stdin: 'world',
        })
    );
    await http(
        'execute_args',
        '/api/v2/execute',
        json({
            ...base_req,
            files: [{ name: 'm.sh', content: 'echo "args:$@"' }],
            args: ['a', 'b'],
        })
    );
    await http(
        'execute_exit_code',
        '/api/v2/execute',
        json({
            ...base_req,
            files: [{ name: 'm.sh', content: 'echo e >&2; exit 3' }],
        })
    );
    await http(
        'execute_alias',
        '/api/v2/execute',
        json({ ...base_req, language: 'sh' })
    );
    await http(
        'execute_semver_range',
        '/api/v2/execute',
        json({ ...base_req, version: '*' })
    );
    await http(
        'execute_timeout',
        '/api/v2/execute',
        json({
            ...base_req,
            files: [{ name: 'm.sh', content: 'sleep 10' }],
            run_timeout: 500,
        })
    );
    await http(
        'execute_output_limit',
        '/api/v2/execute',
        json({
            ...base_req,
            files: [
                { name: 'm.sh', content: 'yes abcdefghij | head -c 100000' },
            ],
        })
    );
    await http(
        'execute_path_escape',
        '/api/v2/execute',
        json({
            ...base_req,
            files: [{ name: '../escape.sh', content: 'echo nope' }],
        })
    );
    await http(
        'execute_empty_files',
        '/api/v2/execute',
        json({ ...base_req, files: [] })
    );
    // OPTIONS is exempt from the content-type gate
    await http('options_execute', '/api/v2/execute', { method: 'OPTIONS' });

    // The gate is mounted on the whole /api/v2 prefix, so it applies to paths
    // that match no route - those are a 415 before they are a 404.
    await http('unmatched_v2_post_no_ct', '/api/v2/nope', {
        method: 'POST',
        raw_body: '{}',
    });
    await http('unmatched_v2_post_json', '/api/v2/nope', json({}));
    // Body parsing runs before the gate, so malformed json is a 400 even on a
    // path that matches no route.
    await http('unmatched_v2_bad_json', '/api/v2/nope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        raw_body: '{not json',
    });
    await http('unmatched_v2_get', '/api/v2/nope');
    await http('head_root', '/', { method: 'HEAD' });
    // A syntactically valid but non-object json body
    await http('execute_scalar_body', '/api/v2/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        raw_body: '"just a string"',
    });
    await http('execute_array_body', '/api/v2/execute', json([]));
}

// ------------------------------------------------------------ WebSocket

interface WsOutcome {
    messages: unknown[];
    close_code: number | null;
    close_reason: string;
    error?: string;
}

function ws_case(
    name: string,
    drive: (ws: WebSocket, done: () => void) => void,
    timeout_ms = 20000
): Promise<void> {
    return new Promise(resolve => {
        const out: WsOutcome = {
            messages: [],
            close_code: null,
            close_reason: '',
        };
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            results[name] = out;
            try {
                ws.close();
            } catch {
                /* already closed */
            }
            resolve();
        };

        const ws = new WebSocket(WS_BASE + '/api/v2/connect');
        const timer = setTimeout(() => {
            out.error = 'timeout';
            finish();
        }, timeout_ms);

        ws.addEventListener('message', ev => {
            try {
                out.messages.push(JSON.parse(String(ev.data)));
            } catch {
                out.messages.push(String(ev.data));
            }
        });
        ws.addEventListener('close', ev => {
            out.close_code = ev.code;
            out.close_reason = ev.reason;
            clearTimeout(timer);
            finish();
        });
        ws.addEventListener('error', () => {
            out.error = 'socket error';
        });
        ws.addEventListener('open', () => drive(ws, finish));
    });
}

const init_msg = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'init', ...base_req, ...over });

async function capture_ws() {
    // full successful lifecycle -> 4999
    await ws_case('ws_lifecycle', ws => {
        ws.send(init_msg());
    });

    // init twice -> 4000
    await ws_case('ws_double_init', ws => {
        ws.send(init_msg({ files: [{ name: 'm.sh', content: 'sleep 2' }] }));
        setTimeout(() => ws.send(init_msg()), 200);
    });

    // never init -> 4001 after ~1s
    await ws_case('ws_init_timeout', () => {
        /* deliberately silent */
    });

    // data before init -> 4003
    await ws_case('ws_data_before_init', ws => {
        ws.send(JSON.stringify({ type: 'data', stream: 'stdin', data: 'x' }));
    });

    // signal before init -> 4003
    await ws_case('ws_signal_before_init', ws => {
        ws.send(JSON.stringify({ type: 'signal', signal: 'SIGKILL' }));
    });

    // writing to a stream other than stdin -> 4004
    await ws_case('ws_bad_stream', ws => {
        ws.send(init_msg({ files: [{ name: 'm.sh', content: 'sleep 2' }] }));
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

    // unknown signal name -> 4005
    await ws_case('ws_invalid_signal', ws => {
        ws.send(init_msg({ files: [{ name: 'm.sh', content: 'sleep 2' }] }));
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

    // malformed json -> error message then 4002
    await ws_case('ws_malformed', ws => {
        ws.send('this is not json');
    });

    // stdin streamed over the socket
    await ws_case('ws_stdin', ws => {
        ws.send(
            init_msg({
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

    // a real signal is delivered and kills the stage
    await ws_case('ws_signal_delivered', ws => {
        ws.send(init_msg({ files: [{ name: 'm.sh', content: 'sleep 10' }] }));
        setTimeout(
            () =>
                ws.send(JSON.stringify({ type: 'signal', signal: 'SIGKILL' })),
            800
        );
    });

    // stop-signals are ACCEPTED (not 4005) but never delivered - the job keeps
    // running and exits normally. This is the invariant in CLAUDE.md that has
    // no other guard.
    await ws_case('ws_stop_signal_accepted', ws => {
        ws.send(
            init_msg({
                files: [{ name: 'm.sh', content: 'sleep 1; echo done' }],
            })
        );
        setTimeout(
            () =>
                ws.send(JSON.stringify({ type: 'signal', signal: 'SIGSTOP' })),
            300
        );
    });

    // A file escaping the submission directory throws inside prime(), and that
    // message reaches the client as an `error` before the 4002. Pinned because
    // rewording that internal throw would be a contract change on this path.
    await ws_case('ws_path_escape', ws => {
        ws.send(
            init_msg({
                files: [{ name: '../escape.sh', content: 'echo nope' }],
            })
        );
    });

    // An unrecognised message type is ignored - the switch has no default - so
    // the socket stays open and only the init timeout closes it.
    await ws_case('ws_unknown_type', ws => {
        ws.send(JSON.stringify({ type: 'nonsense', whatever: 1 }));
    });

    // A validation failure on init surfaces as an `error` message + 4002,
    // not as an HTTP 400.
    await ws_case('ws_init_invalid', ws => {
        ws.send(JSON.stringify({ type: 'init', version: '5.0.0', files: [] }));
    });

    await ws_case('ws_empty_files', ws => {
        ws.send(init_msg({ files: [] }));
    });

    // a signal Node has no name for must not take the job down
    await ws_case('ws_rt_signal', ws => {
        ws.send(
            init_msg({
                files: [{ name: 'm.sh', content: 'sleep 1; echo done' }],
            })
        );
        setTimeout(
            () =>
                ws.send(
                    JSON.stringify({ type: 'signal', signal: 'SIGRTMIN+1' })
                ),
            300
        );
    });
}

// ---------------------------------------------------------------- main

console.error('capturing http...');
await capture_http();
console.error('capturing websocket...');
await capture_ws();
console.log(JSON.stringify(results, null, 2));
console.error('done');
