#!/usr/bin/env bash
#
# Emit one `<language>-<version>` package slug per line.
#
# A package is a single manifest at `packages/<language>/<version>.yaml`, so a
# slug maps back to a file by splitting on the first dash - language names never
# contain one, versions do (python-3.10.0-alpha.7).
#
# Usage:
#   changed-packages.sh diff <base> <head>   packages touched between two commits
#   changed-packages.sh all                  every manifest in the tree
#   changed-packages.sh list <file>          slugs from a file, # comments allowed
#   changed-packages.sh explicit "<slugs>"   slugs from a whitespace-separated string
#   changed-packages.sh built                only manifests that need a source build
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

manifest_for() {
    local slug=$1
    echo "packages/${slug%%-*}/${slug#*-}.yaml"
}

# Drop slugs with no manifest behind them - a package deleted in the same commit
# that touched it cannot be built.
keep_existing() {
    local slug
    while read -r slug; do
        [[ -n "$slug" ]] || continue
        if [[ -f "$(manifest_for "$slug")" ]]; then
            echo "$slug"
        else
            echo "skipping $slug: $(manifest_for "$slug") does not exist" >&2
        fi
    done | sort -u
}

# A manifest with `build:` or `post_install:` needs a toolchain, so CI has to
# build and publish it. Everything else the engine installs straight from
# upstream and CI never touches.
needs_build() {
    local slug
    while read -r slug; do
        [[ -n "$slug" ]] || continue
        if grep -qE '^(build|post_install):' "$(manifest_for "$slug")"; then
            echo "$slug"
        fi
    done
}

all_slugs() {
    find packages -mindepth 2 -maxdepth 2 -name '*.yaml' |
        sed 's|^packages/||; s|\.yaml$||; s|/|-|'
}

mode=${1:-}

case "$mode" in
    diff)
        base=${2:?diff needs a base commit}
        head=${3:?diff needs a head commit}

        # Shallow clones and force-pushed branches may not have the base locally.
        git cat-file -e "$base^{commit}" 2> /dev/null ||
            git fetch --no-tags --depth=1 origin "$base" > /dev/null 2>&1 || true

        git diff --name-only "$base" "$head" -- packages/ |
            grep -E '^packages/[^/]+/[^/]+\.yaml$' |
            sed 's|^packages/||; s|\.yaml$||; s|/|-|' |
            keep_existing
        ;;
    all)
        all_slugs | keep_existing
        ;;
    built)
        all_slugs | keep_existing | needs_build
        ;;
    list)
        file=${2:?list needs a file}
        sed -e 's/#.*//' -e 's/[[:space:]]//g' "$file" | keep_existing
        ;;
    explicit)
        printf '%s\n' ${2:-} | keep_existing
        ;;
    *)
        echo "usage: $0 {diff <base> <head>|all|built|list <file>|explicit \"<slugs>\"}" >&2
        exit 1
        ;;
esac
