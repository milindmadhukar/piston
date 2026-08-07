#!/usr/bin/env bash
#
# Installs one package on a real instance and runs the `test` block from its own
# manifest through /api/v2/execute.
#
#   .github/scripts/test-package.sh go-1.26.5
#
# A prebuilt package installs straight from upstream. For one that needs a
# source build, packages/<slug>.pkg.tar.gz (as produced by build-package.sh) is
# served locally so the archive CI just built is what gets tested.
set -euo pipefail

SLUG=${1:?usage: test-package.sh <language>-<version>}
LANGUAGE=${SLUG%%-*}
VERSION=${SLUG#*-}

cd "$(git rev-parse --show-toplevel)"

MANIFEST="packages/$LANGUAGE/$VERSION.yaml"
[ -f "$MANIFEST" ] || { echo "::error::no manifest at $MANIFEST"; exit 1; }

ARCHIVE="packages/$SLUG.pkg.tar.gz"
CONTAINER="pkgtest-$$"
SERVER="pkgtest-serve-$$"
DATA=$(mktemp -d)
chmod 777 "$DATA"

cleanup() {
    docker rm -f "$CONTAINER" "$SERVER" > /dev/null 2>&1 || true
    rm -f packages/index
    sudo rm -rf "$DATA" 2> /dev/null || rm -rf "$DATA" 2> /dev/null || true
}
trap cleanup EXIT

echo "==> Building the API image"
docker build --target runtime -t piston-api -f api/Dockerfile .

if [ -f "$ARCHIVE" ]; then
    # PISTON_REPO_URL is only consulted for packages that need a source build.
    # Point it at a throwaway file server holding what we just built.
    echo "==> Serving $ARCHIVE locally"
    printf '%s\n' "$LANGUAGE,$VERSION,$(sha256sum "$ARCHIVE" | cut -d' ' -f1),http://127.0.0.1:8000/$SLUG.pkg.tar.gz" \
        > packages/index

    docker run -d --name "$SERVER" -p 127.0.0.1:8000:8000 \
        -v "$PWD/packages:/srv:ro" -w /srv \
        python:3-slim python3 -m http.server 8000 > /dev/null

    # Sharing the server's network namespace is what makes 127.0.0.1:8000 resolve
    # from inside the API container.
    NETWORK=(--network "container:$SERVER" -e PISTON_REPO_URL=http://127.0.0.1:8000/index)
else
    NETWORK=()
fi

echo "==> Starting the API"
docker run -d --privileged --name "$CONTAINER" \
    "${NETWORK[@]+"${NETWORK[@]}"}" \
    -v "$DATA:/piston/packages" \
    piston-api > /dev/null

# Driven from inside the container so this works whether or not the API has a
# published port of its own.
api() {
    docker exec "$CONTAINER" bun -e "
        const res = await fetch('http://127.0.0.1:2000' + process.argv[1], {
            method: process.argv[2] ?? 'GET',
            headers: { 'Content-Type': 'application/json' },
            ...(process.argv[3] ? { body: process.argv[3] } : {}),
        });
        process.stdout.write(await res.text());
    " -- "$@"
}

echo "==> Waiting for the API"
for _ in $(seq 1 60); do
    if api / > /dev/null 2>&1; then break; fi
    sleep 2
done

echo "==> Installing $LANGUAGE $VERSION"
api /api/v2/packages POST "{\"language\":\"$LANGUAGE\",\"version\":\"$VERSION\"}"
echo

# The manifest is the single source of truth for what to run and what to expect.
read -r TEST_LANGUAGE EXPECT <<< "$(bun -e '
    const { parse_manifest } = await import("./api/src/manifest.ts");
    const file = process.argv[1];
    const m = parse_manifest(await Bun.file(file).text(), file);
    if (!m.test) { console.error("manifest has no test block"); process.exit(1); }
    console.log(`${m.test.language ?? m.language} ${m.test.expect}`);
' -- "$MANIFEST")"

REQUEST=$(bun -e '
    const { parse_manifest } = await import("./api/src/manifest.ts");
    const file = process.argv[1];
    const m = parse_manifest(await Bun.file(file).text(), file);
    process.stdout.write(JSON.stringify({
        language: process.argv[2],
        version: m.version,
        files: [{ content: m.test.source }],
    }));
' -- "$MANIFEST" "$TEST_LANGUAGE")

echo "==> Executing as $TEST_LANGUAGE, expecting '$EXPECT'"
RESULT=$(api /api/v2/execute POST "$REQUEST")
jq . <<< "$RESULT"

if ! grep -qF "$EXPECT" <<< "$(jq -r '.run.output // ""' <<< "$RESULT")"; then
    echo "::error::$SLUG did not produce '$EXPECT'"
    docker logs "$CONTAINER" | tail -30
    exit 1
fi

echo "==> $SLUG OK"
