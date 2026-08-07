/**
 * Diffs a fresh capture against the recorded baseline.
 *
 *   bun run api/tests/capture_baseline.ts > /tmp/current.json
 *   bun run api/tests/compare_baseline.ts api/tests/baseline.json /tmp/current.json
 *
 * Fields that legitimately vary run-to-run are normalised away rather than
 * ignored wholesale, so a structural change still shows up as a difference.
 */

/** Measured values that differ on every run; compared for presence and type only. */
const VOLATILE = new Set(['memory', 'cpu_time', 'wall_time']);

/**
 * Engine-specific text. The JSON parse error message and the body-parser stack
 * are produced by the JavaScript engine, not by piston, so their wording is not
 * part of the v2 contract - only the status code and the field's presence are.
 */
const ENGINE_TEXT = new Set(['stack']);

type Json = unknown;

function normalise(value: Json, key?: string): Json {
    if (key && VOLATILE.has(key)) {
        return value === null ? null : `<${typeof value}>`;
    }
    if (key && ENGINE_TEXT.has(key)) {
        return typeof value === 'string' ? '<engine text>' : value;
    }
    if (Array.isArray(value)) return value.map(v => normalise(v));
    if (value && typeof value === 'object') {
        const out: Record<string, Json> = {};
        for (const [k, v] of Object.entries(value)) out[k] = normalise(v, k);
        return out;
    }
    return value;
}

/** The WS `error` message for malformed JSON is engine wording too. */
function normalise_case(name: string, value: Json): Json {
    const normalised = normalise(value);
    if (
        name === 'ws_malformed' &&
        normalised &&
        typeof normalised === 'object'
    ) {
        const c = normalised as {
            messages?: { type?: string; message?: string }[];
        };
        c.messages = c.messages?.map(m =>
            m.type === 'error' ? { ...m, message: '<engine text>' } : m
        );
    }
    return normalised;
}

const [, , baseline_path, current_path] = process.argv;
if (!baseline_path || !current_path) {
    console.error('usage: compare_baseline.ts <baseline.json> <current.json>');
    process.exit(2);
}

const baseline: Record<string, Json> = await Bun.file(baseline_path).json();
const current: Record<string, Json> = await Bun.file(current_path).json();

const all_keys = [
    ...new Set([...Object.keys(baseline), ...Object.keys(current)]),
].sort();

let differences = 0;
let matches = 0;

for (const key of all_keys) {
    if (!(key in baseline)) {
        console.log(
            `+ ${key}: present in current only (new case, not a break)`
        );
        continue;
    }
    if (!(key in current)) {
        console.log(`MISSING  ${key}: in baseline but not in current`);
        differences++;
        continue;
    }

    const a = JSON.stringify(normalise_case(key, baseline[key]), null, 2);
    const b = JSON.stringify(normalise_case(key, current[key]), null, 2);

    if (a === b) {
        matches++;
        continue;
    }

    differences++;
    console.log(`\nDIFF  ${key}`);
    const a_lines = a.split('\n');
    const b_lines = b.split('\n');
    const max = Math.max(a_lines.length, b_lines.length);
    for (let i = 0; i < max; i++) {
        if (a_lines[i] !== b_lines[i]) {
            if (a_lines[i] !== undefined)
                console.log(`  - ${a_lines[i]?.trim()}`);
            if (b_lines[i] !== undefined)
                console.log(`  + ${b_lines[i]?.trim()}`);
        }
    }
}

console.log(
    `\n${matches}/${
        matches + differences
    } cases identical, ${differences} differing`
);
process.exit(differences === 0 ? 0 : 1);
