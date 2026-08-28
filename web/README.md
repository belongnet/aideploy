# aideploy command builder

This directory is the zero-secret static command builder published at
<https://belongnet.github.io/aideploy/>.

It accepts deployment choices only: the live public cloud (`do`), runtime,
region, and channel. It has no credential fields, no analytics, and makes no
network calls after load.

The four choices — never a credential — are mirrored into the query string so a
configured link is shareable and survives a reload. That is the page's only
stored state: nothing is written to `localStorage`, `sessionStorage`, cookies,
or any server. The generated working command is for the verified source
checkout because the npm package is not published yet; the future `npx` form
is visibly labeled as unavailable.

```bash
npm --prefix web test
npm --prefix web run build
python3 -m http.server --directory web/.pages 4173
```

`fonts/` holds the latin Inter subsets from `@fontsource/inter`, self-hosted so
the page makes no external request. They are font data, not code; their
package, version, and per-file sha256 are recorded in `fonts/PROVENANCE` and
pinned by the test suite.

The build copies an explicit allowlist into the ignored `web/.pages/`
directory. GitHub Pages receives only those site assets, not tests or project
documentation. The workflow uses GitHub's Pages artifact path and grants
`pages: write` plus `id-token: write` only to the deploy job.
