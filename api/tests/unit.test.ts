import { describe, expect, test } from 'bun:test';

import { error_message } from '../src/errors.ts';
import { create, is_log_level, LOG_LEVELS } from '../src/logger.ts';
import globals, { SIGNALS } from '../src/globals.ts';

describe('error_message', () => {
    test('unwraps an Error', () => {
        expect(error_message(new Error('boom'))).toBe('boom');
    });

    test('passes a string through', () => {
        expect(error_message('boom')).toBe('boom');
    });

    test('unwraps the { message } objects get_job rejects with', () => {
        // The v2 validation path throws plain objects, not Errors, and the 400
        // body is built from this.
        expect(
            error_message({ message: 'language is required as a string' })
        ).toBe('language is required as a string');
    });

    test('does not throw on values with no message', () => {
        expect(error_message(null)).toBe('null');
        expect(error_message(undefined)).toBe('undefined');
        expect(error_message(42)).toBe('42');
        expect(error_message({ nope: true })).toBe('[object Object]');
    });
});

describe('logger', () => {
    test('accepts exactly the documented levels', () => {
        for (const level of LOG_LEVELS) expect(is_log_level(level)).toBe(true);
        expect(is_log_level('VERBOSE')).toBe(false);
        expect(is_log_level('info')).toBe(false);
    });

    test('creating a logger does not throw for any level', () => {
        const logger = create('test');
        expect(typeof logger.debug).toBe('function');
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.warn).toBe('function');
        expect(typeof logger.error).toBe('function');
    });
});

describe('SIGNALS table', () => {
    // Narrowing this table turns a previously-accepted request into a 4005
    // close, which is a breaking change to v2. See CLAUDE.md.
    test('includes the realtime signals Node has no constant for', () => {
        const names: string[] = Object.values(SIGNALS);
        expect(names).toContain('SIGRTMIN');
        expect(names).toContain('SIGRTMIN+1');
        expect(names).toContain('SIGRTMAX');
        expect(names).toContain('SIGRTMAX-1');
    });

    test('includes the stop signals, which are accepted but never delivered', () => {
        const names: string[] = Object.values(SIGNALS);
        for (const s of ['SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU']) {
            expect(names).toContain(s);
        }
    });

    test('maps the standard signal numbers', () => {
        expect(SIGNALS[9]).toBe('SIGKILL');
        expect(SIGNALS[15]).toBe('SIGTERM');
        expect(SIGNALS[6]).toBe('SIGABRT');
    });

    test('exposes the same table on the default export', () => {
        expect(globals.SIGNALS).toBe(SIGNALS);
    });
});
