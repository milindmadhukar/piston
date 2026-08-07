import { describe, expect, test } from 'bun:test';

import { JobSlots } from '../src/job_slots.ts';
import { TypedEmitter } from '../src/typed_emitter.ts';
import {
    as_client_message,
    CLOSE_CODES,
    CLOSE_REASONS,
} from '../src/protocol.ts';

describe('JobSlots', () => {
    test('hands out up to the configured capacity without blocking', async () => {
        const slots = new JobSlots(2);
        await slots.acquire();
        await slots.acquire();
        expect(slots.available).toBe(0);
        expect(slots.waiting).toBe(0);
    });

    test('parks a caller once capacity is exhausted', async () => {
        const slots = new JobSlots(1);
        await slots.acquire();

        let acquired = false;
        const pending = slots.acquire().then(() => {
            acquired = true;
        });

        await Bun.sleep(20);
        expect(acquired).toBe(false);
        expect(slots.waiting).toBe(1);

        slots.release();
        await pending;
        expect(acquired).toBe(true);
        expect(slots.available).toBe(0);
    });

    test('a released slot is reusable - the leak this class exists to prevent', async () => {
        const slots = new JobSlots(1);
        for (let i = 0; i < 5; i++) {
            await slots.acquire();
            slots.release();
        }
        expect(slots.available).toBe(1);
        expect(slots.waiting).toBe(0);
    });

    test('wakes waiters in the order they arrived', async () => {
        const slots = new JobSlots(1);
        await slots.acquire();

        const order: number[] = [];
        const waiters = [1, 2, 3].map(n =>
            slots.acquire().then(() => {
                order.push(n);
            })
        );

        await Bun.sleep(10);
        expect(slots.waiting).toBe(3);

        slots.release();
        slots.release();
        slots.release();
        await Promise.all(waiters);

        expect(order).toEqual([1, 2, 3]);
    });

    test('never blocks when nothing is held', async () => {
        const slots = new JobSlots(4);
        await Promise.all([
            slots.acquire(),
            slots.acquire(),
            slots.acquire(),
            slots.acquire(),
        ]);
        expect(slots.available).toBe(0);
    });
});

interface TestEvents {
    ping: [number];
    pong: [string, number];
}

describe('TypedEmitter', () => {
    test('delivers to every listener', () => {
        const bus = new TypedEmitter<TestEvents>();
        const seen: number[] = [];
        bus.on('ping', n => seen.push(n));
        bus.on('ping', n => seen.push(n * 10));
        bus.emit('ping', 1);
        expect(seen).toEqual([1, 10]);
    });

    test('off removes a listener', () => {
        const bus = new TypedEmitter<TestEvents>();
        const seen: number[] = [];
        const listener = (n: number) => seen.push(n);
        bus.on('ping', listener);
        bus.off('ping', listener);
        bus.emit('ping', 1);
        expect(seen).toEqual([]);
        expect(bus.listener_count('ping')).toBe(0);
    });

    test('a listener may remove itself mid-emit', () => {
        // safe_call does exactly this when a stage ends.
        const bus = new TypedEmitter<TestEvents>();
        const seen: number[] = [];
        const listener = (n: number) => {
            seen.push(n);
            bus.off('ping', listener);
        };
        bus.on('ping', listener);
        bus.emit('ping', 1);
        bus.emit('ping', 2);
        expect(seen).toEqual([1]);
    });

    test('emitting an event with no listeners is a no-op', () => {
        const bus = new TypedEmitter<TestEvents>();
        expect(() => bus.emit('pong', 'x', 1)).not.toThrow();
    });
});

describe('protocol', () => {
    test('accepts a message type the server does not handle', () => {
        // v2 ignores unknown types rather than closing. Rejecting them here
        // would turn a previously-ignored frame into a 4002.
        expect(as_client_message({ type: 'nonsense' })).toEqual({
            type: 'nonsense',
        });
    });

    test('rejects payloads that are not messages at all', () => {
        expect(as_client_message(null)).toBeNull();
        expect(as_client_message('a string')).toBeNull();
        expect(as_client_message(42)).toBeNull();
        expect(as_client_message({ nope: true })).toBeNull();
        expect(as_client_message({ type: 5 })).toBeNull();
    });

    test('every close code has a reason string', () => {
        for (const code of Object.values(CLOSE_CODES)) {
            expect(typeof CLOSE_REASONS[code]).toBe('string');
            expect(CLOSE_REASONS[code].length).toBeGreaterThan(0);
        }
    });

    test('close codes match the values documented in readme.md', () => {
        expect(CLOSE_CODES.ALREADY_INITIALIZED).toBe(4000);
        expect(CLOSE_CODES.INITIALIZATION_TIMEOUT).toBe(4001);
        expect(CLOSE_CODES.NOTIFIED_ERROR).toBe(4002);
        expect(CLOSE_CODES.NOT_YET_INITIALIZED).toBe(4003);
        expect(CLOSE_CODES.ONLY_STDIN_WRITABLE).toBe(4004);
        expect(CLOSE_CODES.INVALID_SIGNAL).toBe(4005);
        expect(CLOSE_CODES.JOB_COMPLETED).toBe(4999);
    });
});
