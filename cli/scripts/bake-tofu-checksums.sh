#!/usr/bin/env bash
# Historical filename retained for release compatibility. Checksums are now
# reviewed and committed; release jobs may verify but never fetch and rewrite
# this trust boundary. Pass TOFU_SUMS_FILE for an optional offline re-audit of
# the exact checksum file recorded in the manifest.
set -Eeuo pipefail

[ "${1:-}" = "--check" ] || {
  echo "usage: bake-tofu-checksums.sh --check" >&2
  echo "Checksums are reviewed in source and are never baked during release." >&2
  exit 2
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$HERE/assets/opentofu.json"
VERSION="$(jq -er '.version' "$MANIFEST")"

jq -e '
  (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
  (.baseUrl == "https://github.com/opentofu/opentofu/releases/download") and
  (.checksumsSource.asset == ("tofu_" + .version + "_SHA256SUMS")) and
  (.checksumsSource.sha256 | test("^[a-f0-9]{64}$")) and
  ([.sha256.darwin_arm64, .sha256.darwin_amd64, .sha256.linux_arm64, .sha256.linux_amd64]
    | length == 4 and all(test("^[a-f0-9]{64}$")) and (unique | length == 4))
' "$MANIFEST" >/dev/null

if [ -n "${TOFU_SUMS_FILE:-}" ]; then
  [ -f "$TOFU_SUMS_FILE" ] || { echo "TOFU_SUMS_FILE does not exist" >&2; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    actual_source="$(sha256sum "$TOFU_SUMS_FILE" | awk '{print $1}')"
  else
    actual_source="$(shasum -a 256 "$TOFU_SUMS_FILE" | awk '{print $1}')"
  fi
  expected_source="$(jq -er '.checksumsSource.sha256' "$MANIFEST")"
  [ "$actual_source" = "$expected_source" ] || {
    echo "OpenTofu checksum-file digest mismatch" >&2
    exit 1
  }
  for key in darwin_arm64 darwin_amd64 linux_arm64 linux_amd64; do
    expected="$(jq -er --arg key "$key" '.sha256[$key]' "$MANIFEST")"
    reviewed="$(awk -v file="tofu_${VERSION}_${key}.zip" '$2 == file {print $1}' "$TOFU_SUMS_FILE")"
    [ -n "$reviewed" ] && [ "$reviewed" = "$expected" ] || {
      echo "OpenTofu $key checksum differs from the reviewed source file" >&2
      exit 1
    }
  done
fi

echo "Reviewed OpenTofu $VERSION checksum contract: PASS"
