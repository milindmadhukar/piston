#!/usr/bin/env bash
#
# Builds one package from its manifest and writes packages/<slug>.pkg.tar.gz.
#
#   .github/scripts/build-package.sh gcc-15.3.0
#
# The build runs inside the builder image, through the very same install path a
# self-hoster gets with PISTON_ALLOW_SOURCE_BUILDS=true. There is no second
# build implementation to keep in step with the first - CI just runs the engine
# and tars up what it produced.
set -euo pipefail

SLUG=${1:?usage: build-package.sh <language>-<version>}
LANGUAGE=${SLUG%%-*}
VERSION=${SLUG#*-}

cd "$(git rev-parse --show-toplevel)"

IMAGE=${PISTON_BUILDER_IMAGE:-piston-builder}
CONTAINER="pkgbuild-$$"
OUT=$(mktemp -d)

cleanup() {
    docker rm -f "$CONTAINER" > /dev/null 2>&1 || true
    sudo rm -rf "$OUT" 2> /dev/null || rm -rf "$OUT" 2> /dev/null || true
}
trap cleanup EXIT

if [ -z "${PISTON_BUILDER_IMAGE:-}" ]; then
    echo "==> Building the builder image"
    docker build --target builder -t "$IMAGE" -f api/Dockerfile .
fi

echo "==> Starting $IMAGE"
docker run -d --privileged --name "$CONTAINER" \
    -e PISTON_ALLOW_SOURCE_BUILDS=true \
    -e PISTON_LOG_LEVEL=DEBUG \
    -v "$OUT:/piston/packages" \
    "$IMAGE" > /dev/null

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
OP=$(api /api/v2/operations POST "{\"kind\":\"install\",\"language\":\"$LANGUAGE\",\"version\":\"$VERSION\"}")
ID=$(jq -r '.id // empty' <<< "$OP")

if [ -z "$ID" ]; then
    echo "::error::could not start the install: $OP"
    exit 1
fi

# Follow the log rather than waiting silently - a from-source build can run for
# an hour and a CI job with no output looks hung.
SEEN=0
while true; do
    STATE=$(api "/api/v2/operations/$ID" | jq -r .state)
    LOG=$(api "/api/v2/operations/$ID/log")
    TOTAL=$(wc -l <<< "$LOG")
    if [ "$TOTAL" -gt "$SEEN" ]; then
        tail -n +$((SEEN + 1)) <<< "$LOG"
        SEEN=$TOTAL
    fi
    [ "$STATE" = "running" ] || break
    sleep 5
done

if [ "$STATE" != "succeeded" ]; then
    echo "::error::build of $SLUG $STATE"
    docker logs "$CONTAINER" | tail -50
    exit 1
fi

echo "==> Packaging"
# Tar the installed tree, matching the layout Package#fetch_prebuilt expects:
# the archive root is the package directory's contents.
docker exec "$CONTAINER" tar czf "/tmp/$SLUG.pkg.tar.gz" \
    -C "/piston/packages/$LANGUAGE/$VERSION" .
docker cp "$CONTAINER:/tmp/$SLUG.pkg.tar.gz" "packages/$SLUG.pkg.tar.gz"

ls -lh "packages/$SLUG.pkg.tar.gz"
