#!/usr/bin/env bash
#
# Exercises one package against an already-running instance:
#   install -> run the manifest's own test -> uninstall -> confirm it is gone
#
#   .github/scripts/verify-package.sh http://127.0.0.1:2000 go-1.26.5
#
# Prints one `OK <slug>` or `FAIL <slug> <reason>` line and exits non-zero on
# failure, so it can be driven in a loop over many packages.
set -uo pipefail

BASE=${1:?usage: verify-package.sh <base-url> <language>-<version>}
SLUG=${2:?usage: verify-package.sh <base-url> <language>-<version>}
LANGUAGE=${SLUG%%-*}
VERSION=${SLUG#*-}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MANIFEST="$ROOT/packages/$LANGUAGE/$VERSION.yaml"

fail() {
    echo "FAIL $SLUG $*"
    exit 1
}

[ -f "$MANIFEST" ] || fail "no manifest at packages/$LANGUAGE/$VERSION.yaml"

json() { curl -s --max-time "${TIMEOUT:-3600}" -H 'Content-Type: application/json' "$@"; }

# A build heavy enough to be OOM-killed takes the whole container with it, and
# every package after it then "fails" instantly against nothing. Report that as
# its own state so a caller can stop rather than churn through the rest.
if ! curl -sf --max-time 10 "$BASE/" > /dev/null; then
    echo "UNAVAILABLE $SLUG (no API at $BASE)"
    exit 2
fi

# --------------------------------------------------------------- install

# Start from a known state so the run is repeatable; a leftover install from an
# earlier run would otherwise come back as "Already installed".
json -XDELETE "$BASE/api/v2/packages" \
    -d "{\"language\":\"$LANGUAGE\",\"version\":\"$VERSION\"}" > /dev/null

INSTALL=$(json -XPOST "$BASE/api/v2/packages" \
    -d "{\"language\":\"$LANGUAGE\",\"version\":\"$VERSION\"}")

if [ "$(jq -r '.version // empty' <<< "$INSTALL")" != "$VERSION" ]; then
    fail "install: $(jq -rc '.message // .' <<< "$INSTALL" | head -c 300)"
fi

# ------------------------------------------------------------------ test

# The manifest is the source of truth for what to run and what to expect. A
# package that provides several languages is tested as the one its test names.
read -r TEST_LANGUAGE EXPECT <<< "$(
    cd "$ROOT" && bun -e '
        const { parse_manifest } = await import("./api/src/manifest.ts");
        const file = process.argv[1];
        const m = parse_manifest(await Bun.file(file).text(), file);
        if (!m.test) { console.error("no test block"); process.exit(1); }
        console.log(`${m.test.language ?? m.language} ${m.test.expect}`);
    ' -- "$MANIFEST" 2>/dev/null
)"
[ -n "${TEST_LANGUAGE:-}" ] || fail "manifest has no test block"

REQUEST=$(
    cd "$ROOT" && bun -e '
        const { parse_manifest } = await import("./api/src/manifest.ts");
        const file = process.argv[1];
        const m = parse_manifest(await Bun.file(file).text(), file);
        const language = process.argv[2];
        process.stdout.write(JSON.stringify({
            language,
            version: m.version,
            // Named test.<language>, which is the filename the old per-package
            // test.<ext> files carried. Several compile stages key off the
            // extension, and an unnamed file arrives as fileN.code - a real
            // difference in behaviour, but not the one this is checking.
            files: [{ name: `test.${language}`, content: m.test.source }],
        }));
    ' -- "$MANIFEST" "$TEST_LANGUAGE"
)

RESULT=$(json -XPOST "$BASE/api/v2/execute" -d "$REQUEST")
OUTPUT=$(jq -r '.run.output // ""' <<< "$RESULT")

if ! grep -qF "$EXPECT" <<< "$OUTPUT"; then
    COMPILE=$(jq -r '.compile.output // ""' <<< "$RESULT" | tr '\n' ' ' | head -c 250)
    RUN=$(echo "$OUTPUT" | tr '\n' ' ' | head -c 250)
    MSG=$(jq -r '.message // ""' <<< "$RESULT" | head -c 250)
    # Uninstall anyway so a failure does not leave the instance dirty.
    json -XDELETE "$BASE/api/v2/packages" \
        -d "{\"language\":\"$LANGUAGE\",\"version\":\"$VERSION\"}" > /dev/null
    fail "execute as '$TEST_LANGUAGE' wanted '$EXPECT'${MSG:+ | msg: $MSG}${COMPILE:+ | compile: $COMPILE}${RUN:+ | run: $RUN}"
fi

# ------------------------------------------------------------- uninstall

UNINSTALL=$(json -XDELETE "$BASE/api/v2/packages" \
    -d "{\"language\":\"$LANGUAGE\",\"version\":\"$VERSION\"}")

if [ "$(jq -r '.version // empty' <<< "$UNINSTALL")" != "$VERSION" ]; then
    fail "uninstall: $(jq -rc '.message // .' <<< "$UNINSTALL" | head -c 300)"
fi

# Every language the package provided must be gone from the registry, not just
# the first - that is the bug `provides` packages used to have.
STILL=$(curl -s "$BASE/api/v2/runtimes" |
    jq -r --arg v "$VERSION" '[.[] | select(.version == $v)] | length')
[ "$STILL" = "0" ] || fail "uninstall left $STILL runtime(s) registered"

echo "OK $SLUG"
