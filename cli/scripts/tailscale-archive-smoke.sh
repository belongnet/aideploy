#!/usr/bin/env bash
set -Eeuo pipefail

version="1.98.8"
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64)
    arch="amd64"
    expected="3a55b5900dd7e11e09b6c74d1e46d223d549dfbefbdc1f044a8ab7bdbafb933c"
    ;;
  aarch64 | arm64)
    arch="arm64"
    expected="53eb3ce89d062fd34e393d24a6c8ec08c769fede8eb77fe9c6e347ad4ae00f84"
    ;;
  armv7l | armv7)
    arch="arm"
    expected="3de36af9fa58f465113bc7cfce7cdb5eb7fc2d99d24b48febd819672916b58ac"
    ;;
  *)
    echo "Unsupported Tailscale smoke architecture: $machine" >&2
    exit 1
    ;;
esac

test_root="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-tailscale-smoke.XXXXXX")"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

archive="$test_root/tailscale.tgz"
curl --fail --silent --show-error --location \
  --connect-timeout 10 --max-time 300 \
  --retry 4 --retry-delay 2 --retry-all-errors \
  "https://pkgs.tailscale.com/stable/tailscale_${version}_${arch}.tgz" -o "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
if [ "$actual" != "$expected" ]; then
  echo "Tailscale archive checksum mismatch: expected $expected, got $actual" >&2
  exit 1
fi

tar -xzf "$archive" -C "$test_root"
source_dir="$(find "$test_root" -mindepth 1 -maxdepth 1 -type d -name 'tailscale_*' -print -quit)"
test -x "$source_dir/tailscale"
test -x "$source_dir/tailscaled"
echo "Tailscale $version $arch archive: PASS"
