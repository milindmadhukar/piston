#!/usr/bin/env bun
/**
 * Converts the old `packages/<lang>/<version>/` directories - build.sh,
 * environment, run, compile, metadata.json, test.* - into one manifest per
 * version at `packages/<lang>/<version>.yaml`.
 *
 *   bun run tools/migrate-packages.ts            # dry run, prints a summary
 *   bun run tools/migrate-packages.ts --write    # write the manifests
 *   bun run tools/migrate-packages.ts --write --only go-1.26.5 gcc-15.3.0
 *
 * Everything is converted with a `build:` script, which preserves exactly
 * today's behaviour. Promoting a package to a prebuilt `sources:` entry is a
 * separate, network-touching step - see tools/lock-manifest.ts. This prints
 * which packages look promotable so that step has a worklist.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { emit_yaml, type YamlValue } from './emit.ts';
import { parse_manifest } from '../src/manifest.ts';

const PACKAGES = path.resolve(import.meta.dir, '../../packages');

interface OldMetadata {
    language?: unknown;
    version?: unknown;
    aliases?: unknown;
    provides?: unknown;
    limit_overrides?: unknown;
}

/** Drops a leading `#!` line and the blank lines after it. */
function strip_shebang(text: string): string {
    const lines = text.split('\n');
    if (lines[0]?.startsWith('#!')) lines.shift();
    while (lines[0] !== undefined && lines[0].trim() === '') lines.shift();
    return lines.join('\n').replace(/\s+$/, '') + '\n';
}

function unquote(value: string): string {
    const first = value[0];
    if (
        value.length >= 2 &&
        (first === '"' || first === "'") &&
        value.endsWith(first)
    ) {
        return value.slice(1, -1);
    }
    return value;
}

interface EnvResult {
    env?: Record<string, string>;
    env_script?: string;
}

/**
 * Turns an `environment` file into a declarative map where it can, and falls
 * back to keeping it as shell where it genuinely computes something (exactly
 * one package in the tree does: dotnet's `FSI_PATH=$(find ...)`).
 */
function convert_environment(text: string): EnvResult {
    const body = strip_shebang(text);

    if (/\$\(|`/.test(body)) return { env_script: body };

    const env: Record<string, string> = {};
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;

        const match = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!match) return { env_script: body };

        const [, key, value] = match;
        if (key === undefined || value === undefined)
            return { env_script: body };
        env[key] = unquote(value.trim());
    }

    if (Object.keys(env).length === 0) return { env_script: body };

    // Resolve references to keys defined in the same file, then the two tokens
    // the manifest format understands.
    for (const key of Object.keys(env)) {
        let value = env[key] as string;
        for (let pass = 0; pass < 5 && /\$/.test(value); pass++) {
            for (const [other, replacement] of Object.entries(env)) {
                if (other === key) continue;
                value = value
                    .replaceAll(`\${${other}}`, replacement)
                    .replaceAll(`$${other}`, replacement);
            }
            const before = value;
            value = value
                .replaceAll('${PWD}', '{pkgdir}')
                .replaceAll('$PWD', '{pkgdir}')
                .replaceAll('${PATH}', '{PATH}')
                .replaceAll('$PATH', '{PATH}');
            if (value === before) break;
        }
        env[key] = value;
    }

    // Anything still holding a `$` needs a shell we do not have.
    if (Object.values(env).some(value => value.includes('$'))) {
        return { env_script: body };
    }

    return { env };
}

const COMPILES =
    /(^|\s)(\.\/configure|\.\.\/build\/configure|\.\/Configure|make\b|cmake\b|cargo build|ghc\b|mvn\b|gcc\b|g\+\+\b|scons\b)/m;
const DEPENDS = /(^|\s)source\s+\.\.\//m;
const INSTALLS = /(pip3? install|npm install|install\.sh|git clone)/;

/** A rough read on whether this package is just "download a tarball and untar it". */
function looks_promotable(build: string): boolean {
    if (COMPILES.test(build) || DEPENDS.test(build) || INSTALLS.test(build)) {
        return false;
    }
    const urls = build.match(/https?:\/\/\S+/g) ?? [];
    return urls.length === 1;
}

interface Converted {
    slug: string;
    yaml: string;
    promotable: boolean;
}

async function convert(language: string, version: string): Promise<Converted> {
    const dir = path.join(PACKAGES, language, version);
    const read = (name: string) => Bun.file(path.join(dir, name)).text();

    const metadata = JSON.parse(await read('metadata.json')) as OldMetadata;
    const build = strip_shebang(await read('build.sh'));
    const run = strip_shebang(await read('run'));

    const compile = existsSync(path.join(dir, 'compile'))
        ? strip_shebang(await read('compile'))
        : undefined;

    const { env, env_script } = convert_environment(await read('environment'));

    // test.<language>.<ext> or test.<ext>; the segment after the first dot is
    // the language CI runs it as.
    const test_file = (await fs.readdir(dir)).find(f => f.startsWith('test.'));
    const test = test_file
        ? {
              language: test_file.split('.')[1],
              expect: 'OK',
              source: await read(test_file),
          }
        : undefined;

    const doc: { [key: string]: YamlValue | undefined } = {
        language: String(metadata.language ?? language),
        version: String(metadata.version ?? version),
        aliases: metadata.aliases as string[] | undefined,
        provides: metadata.provides as YamlValue | undefined,
        limit_overrides: metadata.limit_overrides as YamlValue | undefined,
        build,
        env: env as YamlValue | undefined,
        env_script,
        compile,
        run,
        test: test as YamlValue | undefined,
    };

    const yaml = emit_yaml(doc);

    // Round-trip through the real parser so a bad conversion fails here rather
    // than at install time.
    parse_manifest(yaml, `${language}/${version}.yaml`);

    return {
        slug: `${language}-${version}`,
        yaml,
        promotable: looks_promotable(build),
    };
}

// ----------------------------------------------------------------------- run

const args = Bun.argv.slice(2);
const write = args.includes('--write');
const only_at = args.indexOf('--only');
const only = only_at === -1 ? null : new Set(args.slice(only_at + 1));

const languages = (await fs.readdir(PACKAGES, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

const results: Converted[] = [];
const failures: string[] = [];

for (const language of languages) {
    const versions = (
        await fs.readdir(path.join(PACKAGES, language), { withFileTypes: true })
    )
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);

    for (const version of versions) {
        const slug = `${language}-${version}`;
        if (only && !only.has(slug)) continue;

        try {
            const converted = await convert(language, version);
            results.push(converted);

            if (write) {
                await Bun.write(
                    path.join(PACKAGES, language, `${version}.yaml`),
                    converted.yaml
                );
            }
        } catch (e) {
            failures.push(
                `${slug}: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
}

const promotable = results.filter(r => r.promotable);

console.log(`${write ? 'Wrote' : 'Converted'} ${results.length} manifests`);
console.log(
    `${promotable.length} look promotable to prebuilt sources: ` +
        promotable.map(r => r.slug).join(' ')
);

if (failures.length) {
    console.error(`\n${failures.length} failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}
