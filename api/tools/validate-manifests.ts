#!/usr/bin/env bun
/**
 * Validates every package manifest. This is the PR gate: for a prebuilt
 * package it replaces a multi-hour container build with a parse and a hash
 * check.
 *
 *   bun run tools/validate-manifests.ts             # offline: parse + shape
 *   bun run tools/validate-manifests.ts --fetch     # also verify every sha256
 *   bun run tools/validate-manifests.ts --fetch --only go-1.26.5
 */

import path from 'node:path';

import {
    is_engine_installable,
    load_manifests,
    provided_languages,
    type Manifest,
} from '../src/manifest.ts';

const ROOT = path.resolve(import.meta.dir, '../..');
const PACKAGES = path.join(ROOT, 'packages');

const args = Bun.argv.slice(2);
const fetch_sources = args.includes('--fetch');
const only_at = args.indexOf('--only');
const only = only_at === -1 ? null : new Set(args.slice(only_at + 1));

const problems: string[] = [];
const note = (where: string, message: string) =>
    problems.push(`${where}: ${message}`);

let manifests: Manifest[];
try {
    manifests = await load_manifests(PACKAGES);
} catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
}

const selected = only
    ? manifests.filter(m => only.has(`${m.language}-${m.version}`))
    : manifests;

// ------------------------------------------------------- structural checks

const seen = new Map<string, string>();
for (const manifest of manifests) {
    const key = `${manifest.language}-${manifest.version}`;
    const previous = seen.get(key);
    if (previous) note(manifest.origin, `duplicates ${previous}`);
    seen.set(key, manifest.origin);
}

for (const manifest of selected) {
    const where = path.relative(ROOT, manifest.origin);

    if (!manifest.test) {
        note(where, 'has no test block');
    }

    // A prebuilt package must declare the glibc it needs, so CI can refuse a
    // binary the base image cannot run rather than shipping one that segfaults.
    if (is_engine_installable(manifest) && manifest.glibc === undefined) {
        note(where, 'is prebuilt but does not declare a glibc floor');
    }

    // The migration derived test.language from the old test.<ext> filename,
    // which is not always a name the runtime answers to - python2's test was
    // test.py, but it provides py2 and python2, so `py` resolves to nothing and
    // the package can never be tested.
    if (manifest.test) {
        const answers_to = new Set([
            ...provided_languages(manifest),
            ...(manifest.aliases ?? []),
            ...(manifest.provides ?? []).flatMap(p => p.aliases ?? []),
        ]);
        const as = manifest.test.language ?? manifest.language;
        if (!answers_to.has(as)) {
            note(
                where,
                `test runs as "${as}", which this package does not provide ` +
                    `(has: ${[...answers_to].join(', ')})`
            );
        }
    }

    for (const language of provided_languages(manifest)) {
        if (language.trim() !== language || language === '') {
            note(where, `provides a malformed language name: "${language}"`);
        }
    }
}

// ------------------------------------------------------ multi-engine languages

/**
 * Several packages can provide one language - javascript comes from node, deno
 * and bun. A request resolves by language-or-alias plus a semver range and takes
 * the highest version, so a bare `javascript` picks whichever engine happens to
 * carry the biggest version number. The only stable way to ask for one engine is
 * a name that belongs to it alone, which is what these two rules guarantee
 * exists.
 *
 * Grouped by the *package* name rather than by manifest: node 18 and node 20 are
 * one engine and share their aliases legitimately.
 */
const aliases_for = (manifest: Manifest, language: string): string[] =>
    manifest.provides
        ? (manifest.provides.find(p => p.language === language)?.aliases ?? [])
        : (manifest.aliases ?? []);

const engines_by_language = new Map<string, Map<string, Set<string>>>();
for (const manifest of manifests) {
    for (const language of provided_languages(manifest)) {
        let engines = engines_by_language.get(language);
        if (!engines) {
            engines = new Map();
            engines_by_language.set(language, engines);
        }

        let aliases = engines.get(manifest.language);
        if (!aliases) {
            aliases = new Set();
            engines.set(manifest.language, aliases);
        }

        for (const alias of aliases_for(manifest, language)) aliases.add(alias);
    }
}

for (const [language, engines] of engines_by_language) {
    if (engines.size < 2) continue;

    const owners = new Map<string, string[]>();
    for (const [engine, aliases] of engines) {
        // Reachable only by guessing an exact version number otherwise.
        if (aliases.size === 0) {
            note(
                `packages/${engine}`,
                `provides "${language}", which ${engines.size} packages provide, ` +
                    `but declares no alias - add one naming the engine, e.g. ` +
                    `"${engine}-${language}"`
            );
        }
        for (const alias of aliases) {
            owners.set(alias, [...(owners.get(alias) ?? []), engine]);
        }
    }

    for (const [alias, sharers] of owners) {
        if (sharers.length > 1) {
            note(
                `packages/${language}`,
                `alias "${alias}" is claimed by ${sharers.join(' and ')}, so it ` +
                    `names no single engine`
            );
        }
    }
}

// --------------------------------------------------------------- readme list

const readme = await Bun.file(path.join(ROOT, 'readme.md')).text();
const listed = new Set(
    readme
        .split('# Supported Languages')[1]
        ?.split('<br>')[0]
        ?.split('\n')
        .map(line => line.trim().replace(/^`|`,?$/g, ''))
        .filter(Boolean) ?? []
);

for (const language of new Set(manifests.flatMap(provided_languages))) {
    if (!listed.has(language)) {
        note('readme.md', `Supported Languages is missing \`${language}\``);
    }
}

// ------------------------------------------------------------ source hashes

if (fetch_sources) {
    for (const manifest of selected) {
        for (const source of manifest.sources) {
            const where = `${path.relative(ROOT, manifest.origin)} ${source.url}`;
            try {
                const response = await fetch(source.url);
                if (!response.ok) {
                    note(where, `${response.status} ${response.statusText}`);
                    continue;
                }

                const hasher = new Bun.CryptoHasher('sha256');
                // @ts-expect-error - Response.body is an async iterable at runtime
                for await (const chunk of response.body) hasher.update(chunk);
                const digest = hasher.digest('hex');

                if (digest !== source.sha256) {
                    note(
                        where,
                        `sha256 is ${digest}, manifest says ${source.sha256}`
                    );
                } else {
                    console.log(`ok  ${where}`);
                }
            } catch (e) {
                note(where, e instanceof Error ? e.message : String(e));
            }
        }
    }
}

// ---------------------------------------------------------------- reporting

const prebuilt = manifests.filter(is_engine_installable).length;
console.log(
    `\n${manifests.length} manifests: ${prebuilt} prebuilt, ` +
        `${manifests.length - prebuilt} built from source`
);

if (problems.length) {
    console.error(`\n${problems.length} problems:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
}

console.log('All manifests valid');
