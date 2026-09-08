#!/usr/bin/env bash
set -Eeuo pipefail

repo="$(git rev-parse --show-toplevel)"
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
marker='# aideploy-publication-guard-v1'

if [ -L "$hook" ]; then
  echo "Refusing to replace a symbolic-link pre-push hook." >&2
  exit 1
fi
if [ -e "$hook" ] && ! grep -Fxq "$marker" "$hook"; then
  echo "Refusing to replace an existing pre-push hook: $hook" >&2
  echo "Chain scripts/publication-guard/pre-push.sh from that hook manually." >&2
  exit 1
fi

python3 - "$hook" "$marker" <<'PY'
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
marker = sys.argv[2]
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(
    "#!/usr/bin/env bash\n"
    + marker
    + "\nset -Eeuo pipefail\n"
    + 'repo="$(git rev-parse --show-toplevel)"\n'
    + 'exec "$repo/scripts/publication-guard/pre-push.sh" "$@"\n',
    encoding="utf-8",
)
os.chmod(path, 0o755)
PY

echo "Installed publication guard at $hook"
