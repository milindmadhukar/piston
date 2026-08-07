# Adding a language package

A package is **one file**: `packages/<language>/<version>.yaml`. It describes where
the runtime comes from and how to compile and run a submission with it.

## Naming

Name a language after its interpreter and the binary it provides — `python`, not
`CPython`; `node`, not `NodeJS`. The version must be semver. The directory name must
equal the `language` field and the filename must equal the `version` field; CI enforces
both, because the filesystem layout is the package index.

## Two kinds of package

**Prebuilt** — the common case, and the one to reach for. Upstream already publishes a
linux-x86_64 tarball, so the engine fetches it, verifies its hash and extracts it. No
build, no CI, no publishing step: the pull request is the whole change.

```yaml
language: go
version: '1.26.5'
aliases: [go, golang]
glibc: none
sources:
    - url: https://dl.google.com/go/go1.26.5.linux-amd64.tar.gz
      sha256: 5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053
env:
    PATH: '{pkgdir}/go/bin:{PATH}'
    GOROOT: '{pkgdir}/go'
compile: |
    go build -o piston_program .
run: |
    shift
    ./piston_program "$@"
test:
    expect: OK
    source: |
        package main
        import "fmt"
        func main() { fmt.Println("OK") }
```

**Built from source** — for a runtime with no usable prebuilt binary. Add a `build:`
script instead of (or as well as) `sources:`. CI builds it once and publishes the result
as an archive, which the engine then installs like any other. Same file format; one
field's difference.

```yaml
build: |
    ./configure --prefix "$PREFIX" && make -j"$(nproc)" && make install
```

Before writing a `build:` script, check whether a prebuilt exists — most modern runtimes
publish one, and several that look like they need compiling do not. Python uses
[python-build-standalone][pbs], GHC publishes a `deb10` bindist, Erlang has
[builds.hex.pm][hex], PHP has [static-php][sphp].

[pbs]: https://github.com/astral-sh/python-build-standalone
[hex]: https://builds.hex.pm
[sphp]: https://dl.static-php.dev

## Fields

| field                   | meaning                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `language`, `version`   | Identity. Must match the path.                                                                                                                        |
| `aliases`               | Other names `/api/v2/execute` accepts. Omit when using `provides`.                                                                                    |
| `provides`              | For a toolchain serving several languages (gcc → c, c++, fortran). Each entry takes its own `aliases` and `limit_overrides`.                          |
| `limit_overrides`       | Per-package limits. Only the keys in `OVERRIDABLE_LIMITS` are accepted.                                                                               |
| `sources`               | Archives to fetch. Each needs `url` and `sha256`; `strip` and `into` are optional.                                                                    |
| `glibc`                 | The glibc floor of the prebuilt binaries, or `none` if static. Required for prebuilt packages so CI can reject a binary the base image cannot run.    |
| `build`, `post_install` | Shell. Their presence is what makes a package need a toolchain.                                                                                       |
| `env`                   | Rendered straight into the runtime environment. `{pkgdir}` is the install directory, `{PATH}` the system PATH.                                        |
| `env_script`            | Escape hatch for a value that must be computed at install time. Prefer `env`.                                                                         |
| `compile`               | Optional. **Its presence is what makes a runtime compiled** — the API reports a separate compile stage with its own timeout. `$@` is every code file. |
| `run`                   | Required. `$1` is the entrypoint filename, the rest are program arguments. stdin is piped in.                                                         |
| `test`                  | `source` plus the `expect` string its output must contain. CI runs it.                                                                                |

`sha256` is mandatory and never inferred. The hash is the artifact's identity: it is what
makes fetching from fifteen different hosts safe.

## Workflow

```sh
# Pin a prebuilt archive: downloads it, records the hash and the glibc floor
./piston lock-pkg go/1.26.5 --url https://dl.google.com/go/go1.26.5.linux-amd64.tar.gz

# Check every manifest parses; --fetch also verifies the published checksums
./piston validate-pkgs
./piston validate-pkgs --fetch

# Only for a package with a `build:` script
./piston build-pkg gcc 15.3.0

# Try it on a real instance and run the manifest's own test
./piston start
./piston ppman install go=1.26.5
.github/scripts/test-package.sh go-1.26.5
```

Add the language to the **Supported Languages** list in `readme.md` — CI fails without it.

Commit as `pkg(<language>-<version>): ...` and open a pull request against `main`.

For a prebuilt package, merging is all that is needed. For one with a `build:` script,
`package-push.yaml` builds and publishes the archive on merge; until that run finishes the
package is listed but not installable.
