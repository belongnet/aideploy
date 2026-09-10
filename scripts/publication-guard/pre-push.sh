#!/usr/bin/env bash
set -Eeuo pipefail

guard_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(git rev-parse --show-toplevel)"
zero='0000000000000000000000000000000000000000'
scanned=0
private_boundary="$(git -C "$repo" config --path --get aideploy.privateBoundaryCommand || true)"

if [ -n "$private_boundary" ]; then
  case "$private_boundary" in
    /*) ;;
    *) echo "aideploy.privateBoundaryCommand must be an absolute path" >&2; exit 2 ;;
  esac
  [ -f "$private_boundary" ] && [ -x "$private_boundary" ] || {
    echo "aideploy.privateBoundaryCommand is not an executable file" >&2
    exit 2
  }
fi

# Hook chains may replay stdin through command substitution, which removes its
# trailing newline. The last ref must still be scanned in that case.
while read -r local_ref local_sha _ remote_sha || [ -n "${local_ref:-}" ]; do
  [ -n "$local_ref" ] || continue
  if [ "$local_sha" = "$zero" ]; then
    continue
  fi
  scanned=1
  if [ "$remote_sha" = "$zero" ] || ! git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    python3 "$guard_dir/scan.py" --repo "$repo" --reachable "$local_sha"
    if [ -n "$private_boundary" ]; then
      "$private_boundary" --repo "$repo" --reachable "$local_sha"
    fi
  else
    python3 "$guard_dir/scan.py" --repo "$repo" --base "$remote_sha" --head "$local_sha"
    if [ -n "$private_boundary" ]; then
      "$private_boundary" --repo "$repo" --base "$remote_sha" --head "$local_sha"
    fi
  fi
done

if [ "$scanned" -eq 0 ]; then
  echo "Publication guard: no commits to publish"
fi
