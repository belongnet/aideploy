#!/usr/bin/env bash
# One checked-in public SemVer drives VERSION, npm metadata, the release tag,
# and the changelog. This script runs both in the monorepo staging layout and
# in the assembled public repository.
set -Eeuo pipefail

CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$CLI_ROOT/../VERSION" ]; then
  PUBLIC_ROOT="$(cd "$CLI_ROOT/.." && pwd)"
elif [ -f "$CLI_ROOT/../public-root/VERSION" ]; then
  PUBLIC_ROOT="$(cd "$CLI_ROOT/../public-root" && pwd)"
else
  echo "Could not find the public VERSION file" >&2
  exit 1
fi

VERSION="$(tr -d '\r\n' <"$PUBLIC_ROOT/VERSION")"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  echo "VERSION must contain one npm-compatible SemVer, got: $VERSION" >&2
  exit 1
fi

PACKAGE_VERSION="$(jq -er '.version' "$CLI_ROOT/package.json")"
LOCK_PACKAGE_VERSION="$(jq -er '.version' "$CLI_ROOT/package-lock.json")"
LOCK_ROOT_VERSION="$(jq -er '.packages[""].version' "$CLI_ROOT/package-lock.json")"
for candidate in "$PACKAGE_VERSION" "$LOCK_PACKAGE_VERSION" "$LOCK_ROOT_VERSION"; do
  if [ "$candidate" != "$VERSION" ]; then
    echo "Version contract mismatch: VERSION=$VERSION, npm metadata contains $candidate" >&2
    exit 1
  fi
done

grep -Fq "## [$VERSION]" "$PUBLIC_ROOT/CHANGELOG.md" || {
  echo "CHANGELOG.md is missing a ## [$VERSION] release section" >&2
  exit 1
}

case "${GITHUB_REF:-}" in
  refs/tags/*)
    RELEASE_TAG="${GITHUB_REF#refs/tags/}"
    if [ "$RELEASE_TAG" != "v$VERSION" ]; then
      echo "Release tag must be v$VERSION, got $RELEASE_TAG" >&2
      exit 1
    fi
    ;;
esac

printf 'Public version contract: %s\n' "$VERSION"
