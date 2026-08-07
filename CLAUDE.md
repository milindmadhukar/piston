# Piston

## API stability — read before changing anything under `api/src/api/`

The v2 endpoints are **live and in public use**. Do not make breaking changes to them.

A change is breaking if it alters anything an existing client can already observe:

- request shapes or accepted fields on `/api/v2/execute`, `/api/v2/runtimes`, `/api/v2/packages`
- response fields, their types, or their nullability
- the `/api/v2/connect` WebSocket protocol — message `type` values, their payload
  fields, or the `4000`-`4999` close codes (documented in `readme.md`)
- which inputs are accepted vs. rejected (e.g. narrowing the set of valid signals turns
  a previously-accepted request into a `4005` close — that is breaking)

If a change requires any of the above, **stop and propose a v3 instead**. Ask before
building it; do not silently reshape v2.

What is always fine:

- fixing a bug so an endpoint does what `readme.md` / `docs/api-v2.md` already document
- adding new optional request fields, or new response fields, that old clients ignore
- anything behind a new endpoint or a new version prefix

When in doubt, check whether `readme.md` documents the current behavior. If it does, match
the docs. If the code and the docs disagree, the docs are the contract — fix the code.

## This is a fork — nothing comes from upstream

Upstream (`engineer-man/piston`) is in maintenance mode. This repository is
self-sufficient: images are built from its own source, and packages are described by
manifests it owns.

## Packages are single-file manifests

One file per language version: `packages/<language>/<version>.yaml`. It holds identity,
aliases, `provides`, limit overrides, where the runtime comes from, the `compile` and
`run` shell, and a `test`. There is no `build.sh`/`environment`/`run`/`metadata.json`
directory any more — `packages/CONTRIBUTING.MD` is the format reference.

**The directory name must equal `language` and the filename must equal `version`.** The
filesystem layout _is_ the index; `load_manifests` rejects a mismatch.

Two kinds, distinguished by one field:

- **`sources:` only** — an upstream prebuilt archive. The engine fetches it, verifies the
  mandatory `sha256` and extracts it. **No CI, no publishing.** Adding a Go release is a
  one-file pull request. Most high-traffic languages are this.
- **`build:` or `post_install:`** — needs a toolchain. CI builds it once via the builder
  image and publishes an archive to the `pkgs` release; the engine installs _that_, still
  checksum-verified against the index at `repo_url`. So the engine has exactly one
  install path: fetch, verify, extract.

`sha256` is mandatory and never inferred — the hash is the artifact's identity, which is
what makes fetching from a dozen different hosts safe. `./piston lock-pkg <lang>/<ver>
--url <url>` pins it and records the `glibc` floor.

Manifests are **baked into the image** and are the whitelist: a language with no manifest
cannot be installed however the request is spelled. `PISTON_ALLOWED_LANGUAGES` narrows it
further at runtime.

### Installing renders the manifest into the old on-disk layout

`Package#install` writes `pkg-info.json`, `.env`, `run` and `compile` into
`/piston/packages/<lang>/<ver>` exactly as before. `runtime.ts`, `job.ts` and the boot
scan are unchanged and know nothing about manifests — a manifest is an authoring and
distribution format, not a runtime one. Keep it that way.

### Two images

`api/Dockerfile` has two targets. **`runtime`** is the default: no toolchain, installs
archives only. **`builder`** adds the compiler set and sets
`PISTON_ALLOW_SOURCE_BUILDS=true`, so it can run a manifest's `build:` script itself.
`builder` is last in the file, so **an untargeted `docker build` produces the wrong
image** — always pass `--target`. The build context is the repository root
(`-f api/Dockerfile .`) so `packages/` can be copied in.

CI does not have a second build implementation: `.github/scripts/build-package.sh` starts
the builder image and drives its own `/api/v2/operations` install, then tars the result.

### Do not use `Bun.write(path, response)` for a download

It hangs indefinitely on a large body on Bun 1.3.14 — this silently wedged every install
of a package bigger than a few megabytes. Stream `response.body` into a `FileSink`
instead, hashing as you go. `Package#fetch_source` is the pattern.

The base images are Debian buster, which is EOL and now served from
`archive.debian.org` with an expired `Release` file. Both stages of `api/Dockerfile`
rewrite `sources.list` and set `Acquire::Check-Valid-Until "false"` to cope. **Do not "fix" this by bumping to bookworm/bullseye** — every language package
is prebuilt against buster's glibc, so a base bump silently breaks runtimes.

## Runtime: Bun, on buster

The API is TypeScript run directly by **Bun** — there is no build step, no `dist/`, and
no `tsc` in the image. `api/Dockerfile` lifts the Bun binary out of `oven/bun:1.3-slim`
into a `debian:buster-slim` stage (pinned to 1.3: the manifest loader needs `Bun.YAML`,
added in 1.2.21); Bun's binary runs on buster's glibc 2.28, so the base
image constraint above is still satisfied. `tsc --noEmit` is a typecheck gate only.

Both packages are `strict: true` with `noUncheckedIndexedAccess`, and there are no `any`
escape hatches — keep it that way. Run `bunx tsc --noEmit` in `api/` and `cli/`.

## Hostile input

`/api/v2/connect` is reachable by untrusted clients, and the sandboxed program is
attacker-controlled. When touching `job.ts` or `v2.ts`, preserve these invariants:

- **Never let a job hold its slot indefinitely.** A slot is taken by
  `JobSlots.acquire()` in `prime()` and returned only by `release()` in `cleanup()`,
  which on the WebSocket path runs after `execute()` resolves. Anything that can stop
  `safe_call`'s exit promise from settling is a permanent slot leak, and once every
  slot has leaked the API accepts requests and never runs them. This is why
  stop-signals (`STOP_SIGNALS` in `job.ts`) are never forwarded to the isolate
  process, and why `v2.ts` kills the running stage on socket close.
  `api/tests/slot_release.test.ts` is what proves this still holds — run it against a
  single-slot instance, not the default 64.
- **Never let a stream error reach the top level.** An unhandled `error` on
  `proc.stdin` (EPIPE, trivially triggered by writing to a program that closed stdin)
  takes down the whole API process. Same for the WebSocket. Bun happens not to emit
  this error where Node does — the handler stays regardless, as defence.
- **Never send on a closed socket.** A job outlives the connection that started it;
  use the `send()` helper in `v2.ts`, which checks `readyState`.
- **Guard every `proc.kill`.** `globals.SIGNALS` includes names the runtime rejects
  (`SIGRTMIN`..`SIGRTMAX`), so an unguarded kill throws on client-supplied input.

## Layout

- `api/src/` — the API server.
    - `index.ts` — the `Bun.serve` entrypoint. Routing uses Bun's native `routes`
      object. `read_json_body` is the body-parse + 415 gate, and its ordering is
      load-bearing: parse first, so malformed JSON is a 400 rather than a 415.
      Bun does **not** fall back to `GET` for `HEAD`, so `HEAD` is declared
      explicitly on every readable route.
    - `api/v2.ts` — request validation and the HTTP and WebSocket handlers.
    - `protocol.ts` — the v2 wire contract: message types, `Stage`/`Stream`/
      `JobStatus`, and the `CLOSE_CODES`/`CLOSE_REASONS` tables. Shared by job,
      v2 and index and owned by none of them. Domain types live with their owning
      module, not here — this is a boundary, not a types bucket.
    - `job.ts` — runs jobs inside [isolate](https://github.com/envicutor/isolate)
      sandboxes. Owns `JobEvents`, the typed bus contract with `v2.ts`.
    - `job_slots.ts` — the concurrency semaphore. See "Hostile input" above.
    - `typed_emitter.ts` — event emitter with checked event names and payloads.
- `api/tests/` — the automated suite.
    - `contract.test.ts` pins the whole v2 surface; needs a running API with the
      `bash` 5.0.0 test package.
    - `slot_release.test.ts` needs an instance with `PISTON_MAX_CONCURRENT_JOBS=1`
      and skips without one — see its header for the command. It exists because at
      the default capacity of 64 a leaked slot cannot make a test fail.
    - `unit.test.ts`, `job_slots.test.ts`, `limits.test.ts` are standalone.
    - `capture_baseline.ts` / `compare_baseline.ts` record and diff the live v2
      behaviour — use them when reworking the HTTP layer.
- `cli/` — the `piston` CLI, and the only WebSocket client in-repo
  (`cli/commands/execute.ts`, `handle_interactive()`).
- `packages/` — one YAML manifest per language version. See above.
- `.github/scripts/` — `changed-packages.sh` (selection), `build-package.sh` (drives the
  builder image), `test-package.sh` (installs a package and runs its manifest's test).
- `api/tools/` — `validate-manifests.ts` (the PR gate), `lock-manifest.ts` (pin a prebuilt
  archive), `migrate-packages.ts` (the one-shot conversion from the old format).
- `tests/` — sandbox-escape exploit scripts, run manually.

## Working on it

- `./piston rebuild` — build and restart the API from this repo's source (dev is default)
- `./piston validate-pkgs [--fetch]` — parse every manifest; `--fetch` verifies checksums
- `./piston lock-pkg <lang>/<ver> --url <url>` — pin a package to a prebuilt archive
- `./piston build-pkg <lang> <ver>` — only for a manifest with a `build:` script
- `./piston ppman install <lang>` — install a runtime into the running instance
- `./piston execute [-t] <lang> <file>` — run something; `-t` uses the WebSocket path
- `./piston lint` — prettier (4 spaces, single quotes, `arrowParens: avoid`)
- `cd api && bun test` — unit + contract suite (contract needs the API running)
- `cd api && bunx tsc --noEmit` — typecheck; same in `cli/`
- `./piston build-pkg <lang> <version>` — build a package tarball locally

### Releasing

Images are published by `.github/workflows/images.yaml`: a push to `main` moves `:edge`,
and a `vX.Y.Z` git tag publishes `:X.Y.Z`, `:X.Y`, `:X` and moves `:latest`. Pull requests
build both images without pushing. Cutting a release is: bump `version` in
`api/package.json`, commit, then push a matching `vX.Y.Z` tag — `release.yaml` fails the
build if the tag and `api/package.json` disagree, because `globals.version` is served on
`GET /`.

Images are `linux/amd64` only, deliberately: every language package is a prebuilt x86_64
binary, so an arm64 image could not run a single runtime.

Code style is snake_case for our own identifiers — functions, variables, fields. Platform
and library APIs keep their own casing (`readFileSync`, `parseInt`, `randomUUID`); the
`nocamel` shim that used to rename them is gone.

### The v2 contract is pinned by tests

`api/tests/contract.test.ts` asserts every status code, message string and close code v2
emits. A failure there is a breaking change, not a flaky test. If you rework the HTTP
layer, capture a baseline first and diff it:

```sh
bun run api/tests/capture_baseline.ts > /tmp/before.json   # against the old build
# ...make changes, rebuild...
bun run api/tests/capture_baseline.ts > /tmp/after.json
bun run api/tests/compare_baseline.ts /tmp/before.json /tmp/after.json
```
