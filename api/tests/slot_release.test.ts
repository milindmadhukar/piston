/**
 * Slot release under real contention.
 *
 * The slot-release case in contract.test.ts runs against the default capacity
 * of 64, so a single leaked slot cannot make it fail - it proves the API still
 * answers, not that the slot came back. This file runs against an instance with
 * `PISTON_MAX_CONCURRENT_JOBS=1`, where a leak blocks the very next job and the
 * failure is unambiguous.
 *
 *   docker run -d --privileged -p 2001:2000 \
 *     -e PISTON_MAX_CONCURRENT_JOBS=1 \
 *     -v "$PWD/data/piston/packages:/piston/packages" \
 *     --name piston_single_slot piston-api
 *   PISTON_SINGLE_SLOT_URL=http://127.0.0.1:2001 bun test tests/slot_release.test.ts
 */
import { describe, expect, test } from 'bun:test';

const BASE = process.env['PISTON_SINGLE_SLOT_URL'];
const LANG = 'bash';
const VERSION = '5.0.0';

const base_req = {
    language: LANG,
    version: VERSION,
    files: [{ name: 'main.sh', content: 'echo ok' }],
};

async function execute(body: unknown, base: string) {
    const res = await fetch(base + '/api/v2/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
}

describe.skipIf(!BASE)('job slots under capacity 1', () => {
    const base = BASE ?? '';

    test('a completed job returns its slot', async () => {
        for (let i = 0; i < 3; i++) {
            const res = await execute(base_req, base);
            expect(res.status).toBe(200);
        }
    });

    test('a job that fails validation never took a slot', async () => {
        const bad = await execute({ ...base_req, language: 12 }, base);
        expect(bad.status).toBe(400);
        const good = await execute(base_req, base);
        expect(good.status).toBe(200);
    });

    test('a job killed by its own timeout returns its slot', async () => {
        const timed_out = await execute(
            {
                ...base_req,
                files: [{ name: 'm.sh', content: 'sleep 10' }],
                run_timeout: 500,
            },
            base
        );
        expect(timed_out.status).toBe(200);

        const started = Date.now();
        const after = await execute(base_req, base);
        expect(after.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test('a path-escape failure returns its slot', async () => {
        // prime() throws after acquiring, so the release path here runs through
        // cleanup() rather than a normal completion.
        const escaped = await execute(
            {
                ...base_req,
                files: [{ name: '../escape.sh', content: 'echo nope' }],
            },
            base
        );
        expect(escaped.status).toBe(500);

        const started = Date.now();
        const after = await execute(base_req, base);
        expect(after.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test('closing a socket mid-run frees the only slot', async () => {
        // The invariant CLAUDE.md cares most about: with one slot, a job that
        // outlives its socket blocks every later job until it times out.
        const ws = new WebSocket(
            base.replace(/^http/, 'ws') + '/api/v2/connect'
        );
        await new Promise<void>(resolve => {
            ws.addEventListener('open', () => {
                ws.send(
                    JSON.stringify({
                        type: 'init',
                        ...base_req,
                        files: [{ name: 'm.sh', content: 'sleep 30' }],
                    })
                );
                setTimeout(() => {
                    ws.close();
                    resolve();
                }, 800);
            });
        });

        const started = Date.now();
        const after = await execute(base_req, base);
        expect(after.status).toBe(200);
        // A leaked slot would park this until the 30s sleep finished.
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test('a queued job runs once the slot frees, rather than being dropped', async () => {
        // Stays inside the configured 3s run_timeout; asking for more would be
        // rejected as exceeding the limit.
        const slow = execute(
            {
                ...base_req,
                files: [{ name: 'm.sh', content: 'sleep 1; echo slow' }],
            },
            base
        );
        // Give the first job time to take the only slot.
        await Bun.sleep(300);
        const queued = execute(base_req, base);

        const [a, b] = await Promise.all([slow, queued]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body).toContain('slow');
    });
});
