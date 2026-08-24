# Project history and release provenance

## Why the public repository began with one commit

`belongnet/aideploy` was launched publicly on August 24, 2026 from a clean,
source-only root commit. The deployable code had previously been developed
inside a private product repository alongside the hosted control plane,
customer integrations, internal workloads, and operational history.

Git history is not just a sequence of patches: every reachable commit preserves
the complete tree at that point. Importing selected-looking commits from the
private repository would therefore risk making private paths or removed
material reachable through Git objects, tags, pull requests, caches, and forks.
The launch used a clean root because preserving that boundary matters more than
displaying an inflated public commit count.

The first public commit is:

```text
0fcfd36acc9db98cac16f1375eef30db1bd4eb73
```

The first clean release is `v0.4.2-beta.3`. Its deterministic base archive
manifest records both that commit and the exact source tree:

```text
commit: 0fcfd36acc9db98cac16f1375eef30db1bd4eb73
tree:   0b737f321674a6373113dde5dc7db64bb958c38b
```

## What was preserved

- Release chronology and notable changes remain in [`CHANGELOG.md`](../CHANGELOG.md).
- Apache and FSL licensing, upstream attribution, and security reporting paths
  remain explicit.
- The public release contains the exact source used by self-host and hosted
  consumers, not a rewritten marketing implementation.
- The original pre-public repository was archived privately for audit and
  incident-response purposes; it is not part of the public trust boundary.

## What happens after launch

From the clean root onward, the public repository uses ordinary, reviewable Git
history. Changes land through protected pull requests with required CI, signed
release artifacts bind back to public tags, and hosted builds consume a pinned
public release rather than a mutable branch.

This gives contributors a clean and truthful history from public launch
forward, while keeping private control-plane and customer code out of every
publicly reachable Git object.
