# aideploy command builder

This directory is the zero-secret static command builder published at
<https://belongnet.github.io/aideploy/>.

It accepts deployment choices only: the live public cloud (`do`), runtime,
region, and channel. It has no credential fields, persistence, analytics, or
network calls. The generated working command is for the verified source
checkout because the npm package is not published yet; the future `npx` form
is visibly labeled as unavailable.

```bash
npm --prefix web test
npm --prefix web run build
python3 -m http.server --directory web/.pages 4173
```

The build copies an explicit allowlist into the ignored `web/.pages/`
directory. GitHub Pages receives only those site assets, not tests or project
documentation. The workflow uses GitHub's Pages artifact path and grants
`pages: write` plus `id-token: write` only to the deploy job.

`vendor/pretext.js` is the MIT-licensed Pretext text-layout bundle used for
resize-aware hero copy. The published site executes it, so `vendor/pretext.js`
is checked in with its license, its upstream package/version/commit, and its
sha256 in `vendor/pretext.PROVENANCE`. The test suite pins that digest, so
replacing the bundle is a reviewable diff instead of a silent swap.
