# tools/

Build, release, and asset-generation scripts. Everything here is **plain Node ESM (`.mjs`),
dev-machine only** — nothing in this folder ships inside the plugin bundle. TypeScript that
gets *compiled* lives under `src/` (the dev-only effects preview server is
`src/effects/preview-server.ts`; its bundle lands here, see below).

## Release pipeline (wired into `package.json`)

| Script | npm script | What it does |
| --- | --- | --- |
| `bump-version.mjs` | `version:patch/minor/major/beta` | Bumps `manifest.json`'s `Version`, rolls `CHANGELOG.md`'s `<!-- NEXT -->` gate (stable bumps), creates commit + git tag. |
| `release.mjs` | `release` (end of `ship:*`) | Pushes commit + tag, creates the GitHub release via `gh`, packs the `.streamDeckPlugin` for manual Marketplace upload (stable only). |

Normal entry point: `npm run ship:patch` / `ship:minor` / `ship:major` / `ship:beta`
(lint → test → build → version → release).

## Build-time codegen (run automatically)

| Script | Trigger | What it does |
| --- | --- | --- |
| `generate-effects-registry.mjs` | `buildStart` of both rollup configs | Scans `src/effects/*/index.ts` → writes `src/effects/registry.generated.ts` + the PI's `effects-manifest.generated.json`. Both outputs are gitignored. |

## Dev tools

| Script | npm script | What it does |
| --- | --- | --- |
| `run-effects-preview.mjs` | `effects:preview` | Builds `src/effects/preview-server.ts` (via `rollup.preview.config.mjs`) into `effects-preview-server.bundle.mjs` (gitignored) and starts it — live effect preview in the browser, see CONTRIBUTING_EFFECTS.md. |

## Asset generators (run manually, on demand)

| Script | Output | What it does |
| --- | --- | --- |
| `generate-icons.mjs` | `<sdPlugin>/imgs/` | `npm run icons` — renders the action/category icons from @mdi/js paths. Run after adding an action. |
| `generate-globe-bitmap.mjs` | `src/effects/boing-globe/landBitmap.ts` | One-time: rasterizes world-atlas land polygons into the committed bit-packed bitmap. Only rerun if resolution/source data changes. |
| `generate-screenshots.mjs` | `docs/screenshots/` | Representative PNG mockups of all actions for README/store. |
| `generate-store-assets.mjs` | `store/` | Marketplace icon/banner assets. |
| `generate-showcase-images.mjs` | `store/` | Marketplace showcase/gallery images (needs `store/lobster_icon.png`). |
| `generate-banner.mjs` | `assets/` | 1280×640 GitHub social-preview banner. |
| `generate-bg.mjs` | `assets/` | 1920×1080 particle background used by other asset generators. |
