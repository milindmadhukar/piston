#!/usr/bin/env bun
/**
 * Promotes a manifest from "build it from source" to "fetch this prebuilt
 * archive", pinning the sha256 and the glibc floor.
 *
 *   bun run tools/lock-manifest.ts go/1.26.5 \
 *     --url https://dl.google.com/go/go1.26.5.linux-amd64.tar.gz
 *
 *   bun run tools/lock-manifest.ts node/20.11.1 \
 *     --url https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz --strip 1
 *
 * The archive is downloaded once to compute its hash and to read the maximum
 * GLIBC symbol version its binaries reference - that number becomes the
 * manifest's `glibc` floor, which CI asserts against the base image. Pass
 * --keep-build to add sources without dropping the build script.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import os from 'node:os';

import { emit_yaml, type YamlValue } from './emit.ts';
import { load_manifest, type Manifest } from '../src/manifest.ts';

const PACKAGES = path.resolve(import.meta.dir, '../../packages');

function flag(name: string): string | undefined {
    const at = Bun.argv.indexOf(`--${name}`);
    return at === -1 ? undefined : Bun.argv[at + 1];
}

const [target] = Bun.argv.slice(2);
const url = flag('url');

if (!target || !target.includes('/') || !url) {
    console.error(
        'usage: lock-manifest.ts <language>/<version> --url <url> [--strip N] [--into DIR] [--keep-build]'
    );
    process.exit(1);
}

const [language, version] = target.split('/');
const file = path.join(PACKAGES, language ?? '', `${version}.yaml`);
const manifest = await load_manifest(file);

// ------------------------------------------------------------- fetch + hash

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'piston-lock-'));
const archive = path.join(scratch, path.basename(new URL(url).pathname));

console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
    console.error(`  ${response.status} ${response.statusText}`);
    process.exit(1);
}
if (!response.body) {
    console.error('  response had no body');
    process.exit(1);
}

// Streamed by hand rather than `Bun.write(path, response)`: on Bun 1.3.14 that
// form hangs indefinitely on a large body. Hashing as we go also saves a
// second pass over a few hundred megabytes.
const hasher = new Bun.CryptoHasher('sha256');
const sink = Bun.file(archive).writer();
for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    hasher.update(chunk);
    sink.write(chunk);
}
await sink.end();

const sha256 = hasher.digest('hex');
console.log(`  sha256 ${sha256}`);

// -------------------------------------------------------------- glibc floor

/**
 * The highest GLIBC_x.y symbol version any ELF in the archive references. That
 * is the real floor: a binary needing 2.31 cannot run on buster's 2.28, and
 * this catches it here instead of at execute time.
 */
function detect_glibc(root: string): string | undefined {
    const probe = cp.spawnSync('bash', [
        '-c',
        `find ${JSON.stringify(root)} -type f -perm -u+x -exec objdump -T {} + 2>/dev/null ` +
            `| grep -oP 'GLIBC_\\K[0-9]+\\.[0-9]+' | sort -V -u | tail -1`,
    ]);
    const found = probe.stdout.toString().trim();
    return found.length ? found : undefined;
}

const extracted = path.join(scratch, 'x');
await fs.mkdir(extracted);

const strip = Number(flag('strip') ?? 0);
const tar_flag =
    manifest.sources[0]?.format === 'zip' || url.endsWith('.zip')
        ? null
        : `--strip-components=${strip}`;

if (tar_flag === null) {
    cp.spawnSync('unzip', ['-q', archive, '-d', extracted]);
} else {
    cp.spawnSync('tar', ['xf', archive, '-C', extracted, tar_flag]);
}

// "none" is a real answer, not a missing one: Go and Zig ship static binaries.
// Recording it explicitly keeps the validator able to insist the field exists.
const glibc = detect_glibc(extracted) ?? 'none';
console.log(`  glibc floor ${glibc}`);

await fs.rm(scratch, { recursive: true, force: true });

// ------------------------------------------------------------------ rewrite

const into = flag('into');
const keep_build = Bun.argv.includes('--keep-build');

function to_doc(m: Manifest): { [key: string]: YamlValue | undefined } {
    return {
        language: m.language,
        version: m.version,
        aliases: m.aliases,
        provides: m.provides as YamlValue | undefined,
        limit_overrides: m.limit_overrides as YamlValue | undefined,
        glibc: glibc ?? m.glibc,
        sources: [
            {
                url: url as string,
                sha256,
                ...(strip ? { strip } : {}),
                ...(into ? { into } : {}),
            },
        ] as YamlValue,
        build: keep_build ? m.build : undefined,
        post_install: m.post_install,
        env: m.env as YamlValue,
        env_script: m.env_script,
        compile: m.compile,
        run: m.run,
        test: m.test as YamlValue | undefined,
    };
}

await Bun.write(file, emit_yaml(to_doc(manifest)));

// Re-read through the real parser so a bad rewrite fails now, not at install.
await load_manifest(file);

console.log(`Locked ${path.relative(process.cwd(), file)}`);
