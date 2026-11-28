# Changelog

## v1.0.0 — first usable release

First version that works end to end. Theme, wallpaper storage, and all four
sliders are wired and verified on a live window.

### Included

- Wallpaper-backed translucent theme built as a DSH bundle: the Host half
  stores images, the browser half applies the material.
- Wallpaper upload, storage, and retrieval over
  `/api/liquid-glass/wallpaper`, content-addressed under
  `$DSH_HOME/liquid-glass/wallpapers/` with the four most recent kept.
- All surface colours go through `ctx.theme.overrideTokens`, with a light and
  a dark value for every token, so the host's own light/dark/system
  preference keeps working.
- Six controls in Settings → General: enable switch, wallpaper, wallpaper
  strength, glass blur, gloss, and glass opacity.
- Frost and rim highlights on the composer, every modal card, and the
  setings panel; a single canvas veil drives the sidebar and chat area.
- Wallpaper upload rejects other origins, non-JSON bodies, unknown MIME
  types, and files above 12 MB.

### Known limits

The material caps out at what token overrides can express:

- No window-level `backdrop-filter` — it would break every inner glass
  surface by creating a backdrop root.
- The canvas is tinted once, in `body::after`; tinting its tokens draws a
  hard edge because the host paints them in a different number of layers per
  region.
- The sidebar is not blurred, because its container holds non-portalled
  `position: fixed` overlays.
- The Windows caption buttons belong to Electron's native
  `titleBarOverlay`; page CSS cannot change their background.
- No refraction or reflection — that needs SVG displacement or WebGL and
  control over host structure.

### Notes

- The npm name `dsh-theme-liquid-glass` is held by another author, so this
  package is distributed from GitHub only. Do not `pnpm publish` it.
- Renaming the package requires updating the module loader `id` in
  `client.js` to match, then re-enabling the plugin; hot reload will not
  replace an already materialized module.