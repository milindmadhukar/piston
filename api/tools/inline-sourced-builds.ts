#!/usr/bin/env bun
/**
 * One-shot repair: inline the build scripts that manifests used to `source`.
 *
 *   bun run tools/inline-sourced-builds.ts [--write]
 *
 * Under the old layout a package that needed another runtime did
 * `source ../../python/2.7.18/build.sh`, which worked because $0 stayed the
 * outer script so the sourced build installed into the dependent's directory.
 * The manifest cutover deleted those directories, so the reference now points
 * at nothing - and because a failed `source` does not abort the script, the
 * build carried on and reported success having installed no runtime at all.
 *
 * The referenced bodies are recovered from the last commit that had them and
 * spliced in, which is what the migration should have done.
 */

import path from 'node:path';
import cp from 'node:child_process';

import { load_manifests } from '../src/manifest.ts';

/** Last commit before the package directories were removed. */
const BEFORE_CUTOVER = process.env['PISTON_CUTOVER_REF'] ?? '745ceb4';

const ROOT = path.resolve(import.meta.dir, '../..');
const PACKAGES = path.join(ROOT, 'packages');

const write = Bun.argv.includes('--write');

/** `source ../../python/2.7.18/build.sh`, with whatever indentation. */
const SOURCE_RE =
    /^([ \t]*)source[ \t]+\.\.\/\.\.\/([^/\s]+)\/([^/\s]+)\/build\.sh[ \t]*$/gm;

function old_build(language: string, version: string): string | null {
    const result = cp.spawnSync(
        'git',
        ['show', `${BEFORE_CUTOVER}:packages/${language}/${version}/build.sh`],
        { cwd: ROOT, encoding: 'utf8' }
    );
    if (result.status !== 0) return null;

    const lines = result.stdout.split('\n');
    if (lines[0]?.startsWith('#!')) lines.shift();
    return lines.join('\n').replace(/\s+$/, '');
}

/**
 * Expands recursively: osabie sources elixir, which itself sources erlang.
 * `seen` breaks a cycle rather than recursing forever.
 */
function expand(body: string, seen: Set<string>, problems: string[]): string {
    return body.replace(
        SOURCE_RE,
        (match, indent: string, language: string, version: string) => {
            const key = `${language}/${version}`;
            if (seen.has(key)) {
                problems.push(`cyclic source of ${key}`);
                return match;
            }

            const sourced = old_build(language, version);
            if (sourced === null) {
                problems.push(`no build.sh for ${key} at ${BEFORE_CUTOVER}`);
                return match;
            }

            const inner = expand(sourced, new Set([...seen, key]), problems);
            const header = `${indent}# --- inlined from the former ${key} package ---`;
            const indented = inner
                .split('\n')
                .map(line => (line.length ? indent + line : line))
                .join('\n');
            return `${header}\n${indented}\n${indent}# --- end of ${key} ---`;
        }
    );
}

const manifests = await load_manifests(PACKAGES);
let changed = 0;
const all_problems: string[] = [];

for (const manifest of manifests) {
    if (!manifest.build) continue;
    SOURCE_RE.lastIndex = 0;
    if (!SOURCE_RE.test(manifest.build)) continue;

    const problems: string[] = [];
    const expanded = expand(
        manifest.build,
        new Set([`${manifest.language}/${manifest.version}`]),
        problems
    );

    for (const problem of problems) {
        all_problems.push(
            `${manifest.language}-${manifest.version}: ${problem}`
        );
    }
    if (expanded === manifest.build) continue;

    const file = manifest.origin;
    const text = await Bun.file(file).text();

    // Splice the expanded body back into the block scalar, preserving the
    // manifest's own indentation rather than re-emitting the whole document.
    const indented = expanded
        .split('\n')
        .map(line => (line.length ? '    ' + line : line))
        .join('\n');

    const start = text.indexOf('build: |');
    const after = text.indexOf('\n', start) + 1;
    // The block ends at the first line that is neither blank nor indented.
    const rest = text.slice(after).split('\n');
    let end = 0;
    while (
        end < rest.length &&
        (rest[end] === '' || rest[end]?.startsWith('    '))
    ) {
        end++;
    }

    const updated =
        text.slice(0, after) + indented + '\n' + rest.slice(end).join('\n');

    console.log(
        `${write ? 'rewrote' : 'would rewrite'} ${path.relative(ROOT, file)}`
    );
    if (write) await Bun.write(file, updated);
    changed++;
}

console.log(`\n${changed} manifests ${write ? 'rewritten' : 'need rewriting'}`);
if (all_problems.length) {
    console.error(`\n${all_problems.length} unresolved:`);
    for (const problem of all_problems) console.error(`  ${problem}`);
    process.exit(1);
}
