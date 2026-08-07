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

## This is a fork — build from this repo, not upstream

Images are built from this repository's `api/` directory. Nothing should pull
`ghcr.io/engineer-man/piston` at build or run time; both compose files use `build: api`,
and CI tags images from `${{ github.repository }}`.

One upstream reference is deliberate: `repo_url` (`api/src/config.ts`) still points at
engineer-man's package index, because that is where the prebuilt language packages are
published. Change it only once this fork publishes its own package releases — otherwise
runtime installation breaks. Override per-deployment with `PISTON_REPO_URL`.

The base images are Debian buster, which is EOL and now served from
`archive.debian.org` with an expired `Release` file. `api/Dockerfile` and
`repo/Dockerfile` rewrite `sources.list` and set `Acquire::Check-Valid-Until "false"`
to cope. **Do not "fix" this by bumping to bookworm/bullseye** — every language package
is prebuilt against buster's glibc, so a base bump silently breaks runtimes.

## Runtime: Bun, on buster

The API is TypeScript run directly by **Bun** — there is no build step, no `dist/`, and
no `tsc` in the image. `api/Dockerfile` lifts the Bun binary out of `oven/bun:1-slim`
into a `debian:buster-slim` stage; Bun's binary runs on buster's glibc 2.28, so the base
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
- `packages/` — language runtime definitions. `repo/`, `builder/` — package building.
- `tests/` — sandbox-escape exploit scripts, run manually.

## Working on it

- `./piston rebuild` — build and restart the API from this repo's source (dev is default)
- `./piston ppman install <lang>` — install a runtime into the running instance
- `./piston execute [-t] <lang> <file>` — run something; `-t` uses the WebSocket path
- `./piston lint` — prettier (4 spaces, single quotes, `arrowParens: avoid`)
- `cd api && bun test` — unit + contract suite (contract needs the API running)
- `cd api && bunx tsc --noEmit` — typecheck; same in `cli/`

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
