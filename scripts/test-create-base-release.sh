#!/usr/bin/env bash
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-base-test.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo/subdir" "$tmp/out-a" "$tmp/out-b"
git -C "$repo" init -q
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.invalid
printf '1.2.3-beta.4\n' >"$repo/VERSION"
printf 'public base\n' >"$repo/subdir/runtime.txt"
git -C "$repo" add -A
GIT_AUTHOR_DATE=2026-01-02T03:04:05Z GIT_COMMITTER_DATE=2026-01-02T03:04:05Z \
  git -C "$repo" commit -qm fixture
git -C "$repo" tag v1.2.3-beta.4
digest="sha256:$(printf 'a%.0s' {1..64})"

"$here/create-base-release.sh" \
  --repo "$repo" --out "$tmp/out-a" --tag v1.2.3-beta.4 \
  --image-digest "$digest" >/dev/null
"$here/create-base-release.sh" \
  --repo "$repo" --out "$tmp/out-b" --tag v1.2.3-beta.4 \
  --image-digest "$digest" >/dev/null

stem="aideploy-base-v1.2.3-beta.4"
cmp "$tmp/out-a/$stem.tgz" "$tmp/out-b/$stem.tgz"
cmp "$tmp/out-a/$stem.manifest.json" "$tmp/out-b/$stem.manifest.json"
cmp "$tmp/out-a/$stem.sha256" "$tmp/out-b/$stem.sha256"

(cd "$tmp/out-a" && shasum -a 256 -c "$stem.sha256")
jq -e \
  --arg commit "$(git -C "$repo" rev-parse HEAD)" \
  --arg tree "$(git -C "$repo" rev-parse 'HEAD^{tree}')" \
  --arg digest "$digest" \
  '.schemaVersion == 1 and
   .repository == "belongnet/aideploy" and
   .releaseTag == "v1.2.3-beta.4" and
   .version == "1.2.3-beta.4" and
   .commitSha == $commit and
   .sourceTreeSha == $tree and
   .runtimeImages.openclaw == $digest' \
  "$tmp/out-a/$stem.manifest.json" >/dev/null
tar -tzf "$tmp/out-a/$stem.tgz" | grep -Fxq "$stem/VERSION"
tar -tzf "$tmp/out-a/$stem.tgz" | grep -Fxq "$stem/subdir/runtime.txt"

printf 'corruption' >>"$tmp/out-a/$stem.tgz"
if (cd "$tmp/out-a" && shasum -a 256 -c "$stem.sha256") >/dev/null 2>&1; then
  echo "checksum verification accepted a modified archive" >&2
  exit 1
fi

echo "public base release fixture: PASS"
