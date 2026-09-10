#!/usr/bin/env bash
set -Eeuo pipefail

repo="$(git rev-parse --show-toplevel)"
source_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
configured_hooks="$(git -C "$repo" config --path --get core.hooksPath || true)"
if [ -n "$configured_hooks" ]; then
  hooks="$configured_hooks"
else
  hooks="$(git -C "$repo" rev-parse --git-path hooks)"
fi
case "$hooks" in
  /*) ;;
  *) hooks="$repo/$hooks" ;;
esac
hook="$hooks/pre-push"
launcher="$hooks/aideploy-publication-guard-pre-push"
marker='# aideploy-publication-guard-v1'
install_hook=1

if [ -L "$hook" ]; then
  echo "Refusing to replace a symbolic-link pre-push hook." >&2
  exit 1
fi
if [ -e "$hook" ] && ! grep -Fxq "$marker" "$hook"; then
  install_hook=0
fi
if [ -L "$launcher" ]; then
  echo "Refusing to replace a symbolic-link publication-guard launcher." >&2
  exit 1
fi
if [ -e "$launcher" ] && ! grep -Fxq "$marker" "$launcher"; then
  echo "Refusing to replace an unrelated publication-guard launcher: $launcher" >&2
  exit 1
fi

python3 - "$hook" "$launcher" "$marker" "$source_dir" "$install_hook" <<'PY'
import hashlib
import os
import pathlib
import shutil
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
launcher = pathlib.Path(sys.argv[2])
marker = sys.argv[3]
source = pathlib.Path(sys.argv[4])
install_hook = sys.argv[5] == "1"
source_names = ("pre-push.sh", "scan.py", "rules.json")
source_files = {name: (source / name).read_bytes() for name in source_names}

digest = hashlib.sha256()
for name in source_names:
    digest.update(name.encode("utf-8") + b"\0" + source_files[name] + b"\0")
snapshot_name = ".aideploy-publication-guard-" + digest.hexdigest()[:16]

path.parent.mkdir(parents=True, exist_ok=True)
snapshot = path.parent / snapshot_name
if snapshot.is_symlink() or (snapshot.exists() and not snapshot.is_dir()):
    raise SystemExit("Refusing an unsafe publication-guard snapshot path")
if snapshot.exists():
    if set(item.name for item in snapshot.iterdir()) != set(source_names):
        raise SystemExit("Refusing a modified publication-guard snapshot")
    for name, expected in source_files.items():
        target = snapshot / name
        if target.is_symlink() or not target.is_file() or target.read_bytes() != expected:
            raise SystemExit("Refusing a modified publication-guard snapshot")
else:
    temporary = pathlib.Path(tempfile.mkdtemp(prefix=".aideploy-publication-guard-install-", dir=path.parent))
    try:
        for name, contents in source_files.items():
            target = temporary / name
            target.write_bytes(contents)
            os.chmod(target, 0o755 if name in {"pre-push.sh", "scan.py"} else 0o644)
        temporary.rename(snapshot)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)

launcher_contents = (
    "#!/usr/bin/env bash\n"
    + marker
    + "\nset -Eeuo pipefail\n"
    + 'hook_dir="$(CDPATH=\'\' cd -- "$(dirname -- "$0")" && pwd -P)"\n'
    + f'exec "$hook_dir/{snapshot_name}/pre-push.sh" "$@"\n'
)


def atomic_launcher(target: pathlib.Path, prefix: str) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=prefix, dir=target.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(launcher_contents)
        os.chmod(temporary, 0o755)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


atomic_launcher(launcher, ".publication-guard-launcher-install-")
if install_hook:
    atomic_launcher(path, ".pre-push-install-")
PY

if [ "$install_hook" -ne 1 ]; then
  echo "Refusing to replace an existing pre-push hook: $hook" >&2
  echo "Chain the immutable publication guard from your existing hook: $launcher" >&2
  exit 1
fi

echo "Installed publication guard at $hook"
