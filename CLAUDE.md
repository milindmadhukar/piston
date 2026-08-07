# Piston

## API stability — read before changing anything under `api/src/api/`

The v2 endpoints are **live and in public use**. Do not make breaking changes to them.

A change is breaking if it alters anything an existing client can already observe:

-   request shapes or accepted fields on `/api/v2/execute`, `/api/v2/runtimes`, `/api/v2/packages`
-   response fields, their types, or their nullability
-   the `/api/v2/connect` WebSocket protocol — message `type` values, their payload
    fields, or the `4000`-`4999` close codes (documented in `readme.md`)
-   which inputs are accepted vs. rejected (e.g. narrowing the set of valid signals turns
    a previously-accepted request into a `4005` close — that is breaking)

If a change requires any of the above, **stop and propose a v3 instead**. Ask before
building it; do not silently reshape v2.

What is always fine:

-   fixing a bug so an endpoint does what `readme.md` / `docs/api-v2.md` already document
-   adding new optional request fields, or new response fields, that old clients ignore
-   anything behind a new endpoint or a new version prefix

When in doubt, check whether `readme.md` documents the current behavior. If it does, match
the docs. If the code and the docs disagree, the docs are the contract — fix the code.

## This is a fork — build from this repo, not upstream

Images are built from this repository's `api/` directory. Nothing should pull
`ghcr.io/engineer-man/piston` at build or run time; both compose files use `build: api`,
and CI tags images from `${{ github.repository }}`.

One upstream reference is deliberate: `repo_url` (`api/src/config.js`) still points at
engineer-man's package index, because that is where the prebuilt language packages are
published. Change it only once this fork publishes its own package releases — otherwise
runtime installation breaks. Override per-deployment with `PISTON_REPO_URL`.

The base images are Debian buster, which is EOL and now served from
`archive.debian.org` with an expired `Release` file. `api/Dockerfile` and
`repo/Dockerfile` rewrite `sources.list` and set `Acquire::Check-Valid-Until "false"`
to cope. **Do not "fix" this by bumping to bookworm/bullseye** — every language package
is prebuilt against buster's glibc, so a base bump silently breaks runtimes.

## Hostile input

`/api/v2/connect` is reachable by untrusted clients, and the sandboxed program is
attacker-controlled. When touching `job.js` or `v2.js`, preserve these invariants:

-   **Never let a job hold its slot indefinitely.** `remaining_job_spaces` is only
    returned in `cleanup()`, which on the WebSocket path runs after `execute()` resolves.
    Anything that can stop `safe_call`'s exit promise from settling is a permanent slot
    leak. This is why stop-signals (`STOP_SIGNALS` in `job.js`) are never forwarded to the
    isolate process, and why `v2.js` kills the running stage on socket close.
-   **Never let a stream error reach the top level.** An unhandled `error` on
    `proc.stdin` (EPIPE, trivially triggered by writing to a program that closed stdin)
    takes down the whole API process. Same for the WebSocket.
-   **Never send on a closed socket.** A job outlives the connection that started it;
    use the `send()` helper in `v2.js`, which checks `readyState`.
-   **Guard every `proc.kill`.** `globals.SIGNALS` includes names Node rejects
    (`SIGRTMIN`..`SIGRTMAX`), so an unguarded kill throws on client-supplied input.

## Layout

-   `api/src/` — the API server. `api/src/api/v2.js` holds the routes; `api/src/job.js`
    runs jobs inside [isolate](https://github.com/envicutor/isolate) sandboxes.
-   `cli/` — the `piston` CLI, and the only WebSocket client in-repo
    (`cli/commands/execute.js`, `handle_interactive()`).
-   `packages/` — language runtime definitions. `repo/`, `builder/` — package building.
-   `tests/` — sandbox-escape exploit scripts, run manually. There is no automated test
    suite, so verify changes end-to-end against a local build.

## Working on it

-   `./piston rebuild` — build and restart the API from this repo's source (dev is default)
-   `./piston ppman install <lang>` — install a runtime into the running instance
-   `./piston execute [-t] <lang> <file>` — run something; `-t` uses the WebSocket path
-   `./piston lint` — prettier (4 spaces, single quotes, `arrowParens: avoid`)

Code style is snake_case throughout, including a `nocamel` shim that exposes Node builtins
under snake_case names (`fs.read_file`, `process.kill`, `set_timeout`).
