#!/usr/bin/env bash
# Create the immutable source input consumed by the hosted/private build.
#
# The archive is produced from an exact Git commit (never the working tree),
# and gzip timestamps are suppressed. Running this command twice for the same
# commit, tag, and image digest must therefore produce identical bytes.
set -Eeuo pipefail

usage() {
  echo "usage: create-base-release.sh --repo <git-repo> --out <empty-or-existing-dir> --tag <vX.Y.Z> --image-digest <sha256:...>" >&2
}

repo=""
out=""
tag=""
image_digest=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --image-digest) image_digest="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

[ -n "$repo" ] && [ -n "$out" ] && [ -n "$tag" ] && [ -n "$image_digest" ] || {
  usage
  exit 2
}
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 2; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }

repo="$(cd "$repo" && pwd -P)"
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"

if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "release tag must be an immutable semantic version beginning with v" >&2
  exit 2
fi
if ! [[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "image digest must be sha256:<64 lowercase hex>" >&2
  exit 2
fi

commit="$(git -C "$repo" rev-parse --verify "${tag}^{commit}")"
head="$(git -C "$repo" rev-parse HEAD)"
if [ "$commit" != "$head" ]; then
  echo "release tag $tag does not resolve to checked-out HEAD $head" >&2
  exit 1
fi
tree="$(git -C "$repo" rev-parse "${commit}^{tree}")"
version="$(git -C "$repo" show "${commit}:VERSION" | tr -d '\r\n')"
if [ "$tag" != "v$version" ]; then
  echo "release tag $tag does not match VERSION $version" >&2
  exit 1
fi

stem="aideploy-base-${tag}"
archive="$out/${stem}.tgz"
manifest="$out/${stem}.manifest.json"
checksum="$out/${stem}.sha256"
prefix="${stem}/"

tmp_archive="$(mktemp "${TMPDIR:-/tmp}/aideploy-base.XXXXXX.tar")"
trap 'rm -f "$tmp_archive"' EXIT
git -C "$repo" archive --format=tar --prefix="$prefix" "$commit" >"$tmp_archive"
gzip --no-name --best --stdout "$tmp_archive" >"$archive"

if command -v sha256sum >/dev/null 2>&1; then
  archive_sha256="$(sha256sum "$archive" | awk '{print $1}')"
else
  archive_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
archive_size="$(wc -c <"$archive" | tr -d ' ')"
commit_time="$(git -C "$repo" show -s --format=%cI "$commit")"

jq -nS \
  --arg repository "belongnet/aideploy" \
  --arg releaseTag "$tag" \
  --arg version "$version" \
  --arg commitSha "$commit" \
  --arg sourceTreeSha "$tree" \
  --arg sourceCommitTime "$commit_time" \
  --arg archiveName "${stem}.tgz" \
  --arg archiveSha256 "$archive_sha256" \
  --argjson archiveSize "$archive_size" \
  --arg openclawRuntime "$image_digest" \
  '{
    schemaVersion: 1,
    repository: $repository,
    releaseTag: $releaseTag,
    version: $version,
    commitSha: $commitSha,
    sourceTreeSha: $sourceTreeSha,
    sourceCommitTime: $sourceCommitTime,
    archive: {
      name: $archiveName,
      sha256: $archiveSha256,
      size: $archiveSize
    },
    runtimeImages: {
      openclaw: $openclawRuntime
    }
  }' >"$manifest"

printf '%s  %s\n' "$archive_sha256" "${stem}.tgz" >"$checksum"
printf '%s\n' "$archive"
printf '%s\n' "$manifest"
printf '%s\n' "$checksum"
