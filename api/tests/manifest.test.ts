/**
 * Manifest parsing, validation and rendering. Pure logic - no API needed.
 */
import { describe, expect, test } from 'bun:test';

import {
    DEFAULT_PATH,
    ManifestError,
    expand_tokens,
    is_engine_installable,
    parse_manifest,
    provided_languages,
    render_env,
    render_pkg_info,
    render_stage,
} from '../src/manifest.ts';

const SHA = 'a'.repeat(64);

const minimal = `
language: go
version: 1.26.5
sources:
  - url: https://example.invalid/go.tar.gz
    sha256: ${SHA}
run: |
  ./out "$@"
`;

const parse = (text: string) => parse_manifest(text, 'test.yaml');

describe('parsing', () => {
    test('accepts a minimal manifest', () => {
        const m = parse(minimal);
        expect(m.language).toBe('go');
        expect(m.version).toBe('1.26.5');
        expect(m.run).toBe('./out "$@"\n');
        expect(m.sources).toHaveLength(1);
        expect(m.sources[0]?.strip).toBe(0);
        expect(m.sources[0]?.format).toBe('tar.gz');
    });

    test('keeps multiline shell verbatim', () => {
        const m = parse(`${minimal}
compile: |
  for f in "$@"; do
    [[ "$f" == *.go ]] || mv -- "$f" "\${f%.code}.go"
  done
  go build -o out .
`);
        expect(m.compile).toBe(
            'for f in "$@"; do\n  [[ "$f" == *.go ]] || mv -- "$f" "${f%.code}.go"\ndone\ngo build -o out .\n'
        );
    });

    test('infers archive format from the url', () => {
        const cases: [string, string][] = [
            ['https://e.invalid/x.tar.xz', 'tar.xz'],
            ['https://e.invalid/x.tgz', 'tar.gz'],
            ['https://e.invalid/x.zip', 'zip'],
            ['https://e.invalid/x.tar.bz2', 'tar.bz2'],
        ];
        for (const [url, format] of cases) {
            const m = parse(`
language: x
version: 1.0.0
sources:
  - url: ${url}
    sha256: ${SHA}
run: "true"
`);
            expect(m.sources[0]?.format).toBe(
                format as (typeof m.sources)[number]['format']
            );
        }
    });

    test('rejects an unknown top-level key', () => {
        expect(() => parse(`${minimal}\nnonsense: 1\n`)).toThrow(ManifestError);
    });

    test('rejects a missing sha256', () => {
        expect(() =>
            parse(`
language: go
version: 1.0.0
sources:
  - url: https://example.invalid/go.tar.gz
run: "true"
`)
        ).toThrow(/sha256/);
    });

    test('rejects a malformed sha256', () => {
        expect(() => parse(minimal.replace(SHA, 'not-a-hash'))).toThrow(
            /64 lowercase hex/
        );
    });

    test('rejects a non-semver version', () => {
        expect(() => parse(minimal.replace('1.26.5', 'latest'))).toThrow(
            /not semver/
        );
    });

    test('rejects a manifest with neither sources nor build', () => {
        expect(() =>
            parse(`
language: x
version: 1.0.0
run: "true"
`)
        ).toThrow(/at least one source or a build script/);
    });

    test('rejects an into path that escapes the package', () => {
        expect(() =>
            parse(`
language: x
version: 1.0.0
sources:
  - url: https://e.invalid/x.tar.gz
    sha256: ${SHA}
    into: ../elsewhere
run: "true"
`)
        ).toThrow(/inside the package/);
    });

    test('rejects a limit override that is not overridable', () => {
        expect(() =>
            parse(`${minimal}
limit_overrides:
  disable_networking: 1
`)
        ).toThrow(/not an overridable limit/);
    });

    test('rejects aliases alongside provides', () => {
        expect(() =>
            parse(`
language: gcc
version: 1.0.0
aliases: [cc]
provides:
  - language: c
sources:
  - url: https://e.invalid/x.tar.gz
    sha256: ${SHA}
run: "true"
`)
        ).toThrow(/belongs on each provides entry/);
    });

    test('parses provides with per-language limit overrides', () => {
        const m = parse(`
language: gcc
version: 15.3.0
provides:
  - language: c
    aliases: [gcc]
  - language: c++
    aliases: [cpp, g++]
    limit_overrides:
      compile_timeout: 20000
sources:
  - url: https://e.invalid/gcc.tar.gz
    sha256: ${SHA}
run: "true"
`);
        expect(provided_languages(m)).toEqual(['c', 'c++']);
        expect(m.provides?.[1]?.limit_overrides?.compile_timeout).toBe(20000);
    });
});

describe('install mode', () => {
    test('sources alone are engine-installable', () => {
        expect(is_engine_installable(parse(minimal))).toBe(true);
    });

    test('a build script is not', () => {
        expect(is_engine_installable(parse(`${minimal}\nbuild: make\n`))).toBe(
            false
        );
    });

    test('post_install is not either', () => {
        expect(
            is_engine_installable(
                parse(`${minimal}\npost_install: pip install x\n`)
            )
        ).toBe(false);
    });
});

describe('rendering', () => {
    test('expands pkgdir and PATH, leaving other braces alone', () => {
        expect(
            expand_tokens('{pkgdir}/bin:{PATH}', '/piston/packages/go/1')
        ).toBe(`/piston/packages/go/1/bin:${DEFAULT_PATH}`);
        expect(expand_tokens('${HOME}/x', '/p')).toBe('${HOME}/x');
    });

    test('PATH default does not include the current directory', () => {
        // A submitted file must not be able to shadow a system binary.
        expect(DEFAULT_PATH.split(':')).not.toContain('.');
    });

    test('renders .env as KEY=value lines', () => {
        const m = parse(`${minimal}
env:
  PATH: "{pkgdir}/go/bin:{PATH}"
  GOROOT: "{pkgdir}/go"
`);
        expect(render_env(m, '/pkg')).toBe(
            `PATH=/pkg/go/bin:${DEFAULT_PATH}\nGOROOT=/pkg/go`
        );
    });

    test('extra env entries win over the manifest', () => {
        const m = parse(`${minimal}\nenv:\n  A: "1"\n`);
        expect(render_env(m, '/pkg', { A: '2' })).toBe('A=2');
    });

    test('renders pkg-info.json with the build platform', () => {
        const m = parse(`${minimal}\naliases: [go, golang]\n`);
        const info = JSON.parse(render_pkg_info(m, 'docker-debian')) as Record<
            string,
            unknown
        >;
        expect(info).toEqual({
            language: 'go',
            version: '1.26.5',
            build_platform: 'docker-debian',
            aliases: ['go', 'golang'],
        });
    });

    test('stage scripts get a bash shebang and a trailing newline', () => {
        expect(render_stage('echo hi')).toBe(
            '#!/usr/bin/env bash\n\necho hi\n'
        );
        expect(render_stage('echo hi\n')).toBe(
            '#!/usr/bin/env bash\n\necho hi\n'
        );
    });
});
