/**
 * Limit precedence, including the zero-override fix.
 *
 * `config` reads the environment once at import time and exits the process if
 * the data directory is missing, so the environment is set up before the
 * dynamic import below rather than at the top of the file.
 */
import { describe, expect, test } from 'bun:test';

process.env['PISTON_DATA_DIRECTORY'] = '/tmp';
process.env['PISTON_MAX_PROCESS_COUNT'] = '64';
process.env['PISTON_RUN_TIMEOUT'] = '3000';
process.env['PISTON_LIMIT_OVERRIDES'] = JSON.stringify({
    // A deliberate zero: previously `||` treated this as absent and silently
    // fell back to the global 64.
    zerolang: { max_process_count: 0 },
    limited: { max_process_count: 8, run_timeout: 500 },
});

const { Runtime } = await import('../src/runtime.ts');

describe('limit precedence', () => {
    test('falls back to the global config when nothing overrides it', () => {
        expect(
            Runtime.compute_single_limit('unconfigured', 'max_process_count')
        ).toBe(64);
    });

    test('an operator override wins over the global', () => {
        expect(
            Runtime.compute_single_limit('limited', 'max_process_count')
        ).toBe(8);
    });

    test('an operator override of 0 is honoured, not treated as absent', () => {
        // The regression this suite exists for.
        expect(
            Runtime.compute_single_limit('zerolang', 'max_process_count')
        ).toBe(0);
    });

    test('an operator override beats a package override', () => {
        expect(
            Runtime.compute_single_limit('limited', 'max_process_count', {
                max_process_count: 999,
            })
        ).toBe(8);
    });

    test('a package override is used when the operator sets nothing', () => {
        expect(
            Runtime.compute_single_limit('unconfigured', 'max_process_count', {
                max_process_count: 16,
            })
        ).toBe(16);
    });

    test('a package override of 0 is honoured too', () => {
        expect(
            Runtime.compute_single_limit('unconfigured', 'max_process_count', {
                max_process_count: 0,
            })
        ).toBe(0);
    });

    test('a negative limit passes through unchanged', () => {
        // -1 means "no limit" for the memory limits and must not be swallowed.
        expect(
            Runtime.compute_single_limit('unconfigured', 'run_memory_limit', {
                run_memory_limit: -1,
            })
        ).toBe(-1);
    });

    test('unrelated limits are unaffected by another language override', () => {
        expect(Runtime.compute_single_limit('limited', 'run_timeout')).toBe(
            500
        );
        expect(
            Runtime.compute_single_limit('unconfigured', 'run_timeout')
        ).toBe(3000);
    });

    test('compute_all_limits assembles the documented shape', () => {
        const limits = Runtime.compute_all_limits('limited');
        expect(limits.max_process_count).toBe(8);
        expect(limits.timeouts.run).toBe(500);
        expect(typeof limits.timeouts.compile).toBe('number');
        expect(typeof limits.cpu_times.run).toBe('number');
        expect(typeof limits.memory_limits.run).toBe('number');
    });
});
