# Project history and release provenance

## The pre-public development history is preserved

AI Deploy's self-host stack was originally developed inside a private product
repository alongside hosted-control-plane and customer-specific code. Before
the public launch, the repository was rewritten with `git filter-repo` so only
the public `stack/`, `terraform/`, `contracts/`, and `VERSION` history survived.
Managed and Belong-specific files were removed from every historical tree, and
governed internal identifiers were removed from surviving commit messages.

The resulting lineage contains 166 public-only commits after the launch files
and early release fixes were layered on top. Its boundaries are:

```text
filtered root: 0697fa72c9a565f4e68da0b3715d4a49fc28587d
audited tip:   a145c13270f268cbeff5f17f9ec7b346d56a4966
tip tree:      da238f2138eacd83090c4728037ccea1690c316d
```

The extraction and layered result passed full-history path, rename,
blocked-identifier, gitleaks, and verified-secret scans. Sixty historical
release labels were derived from the original release commits;
`v0.4.2-beta.2` marks the final audited pre-reset public release. All 61 tags
point only into that audited graph.

## Why GitHub briefly showed only the launch commits

The repository was relaunched on August 24, 2026 from source-only commit
`0fcfd36acc9db98cac16f1375eef30db1bd4eb73` after a late contamination concern.
That response disconnected the already-audited lineage as well as the material
under review, so GitHub's default-branch history showed only the public-launch
commit and later pull requests.

A subsequent forensic audit confirmed that the filtered lineage itself did not
contain the private material. It was reattached as a second parent instead of
rewriting `main`. This preserves the identities and signatures of the clean
launch releases while making the public development history reachable again.

The first clean-root release remains `v0.4.2-beta.3`, with its original source
provenance unchanged:

```text
commit: 0fcfd36acc9db98cac16f1375eef30db1bd4eb73
tree:   0b737f321674a6373113dde5dc7db64bb958c38b
```

Later beta tags, release manifests, signed source archives, and hosted-consumer
pins also retain their original commit and tree identities.

## Ongoing guarantees

- [`scripts/verify-public-history.sh`](../scripts/verify-public-history.sh)
  prevents CI from accepting another default branch that drops either audited
  lineage. Its regression fixture also reconstructs the former six-commit graph
  and proves that ancestry loss fails closed.
- Release chronology and notable changes remain in [`CHANGELOG.md`](../CHANGELOG.md).
- Public release artifacts bind an exact tag, commit, tree, and runtime image
  digest rather than a mutable branch.
- New changes continue to land through reviewed pull requests with required CI.
- Hosted builds consume signed, checksum-pinned public releases and never a
  private repository checkout.

The result is a truthful contributor history without exposing the hosted
control plane, customer integrations, internal workloads, or private operations.
