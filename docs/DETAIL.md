# Liquid glass

English | [中文](DETAIL.zh.md)

Puts a wallpaper under the DeepSeek Harness Web GUI and turns the main surfaces into translucent glass.

## What it does

Three layers stacked, each independent of the others:

| Layer | Implementation | What you see |
| --- | --- | --- |
| Background | The wallpaper (or the built-in cool gradient) plus three slowly drifting color glows, painted on negative-z-index pseudo-elements of `body` | A ground that breathes instead of a flat gradient |
| Surfaces | The host's `--dsw-alias-*` background aliases are replaced with translucent values through the theme service | Sidebar, message area, and cards let the wallpaper show through |
| Material | `backdrop-filter` on the composer card and the settings dialog, plus rim highlights | Frosted glass with a lit edge |

Only the host's background aliases are replaced; there is no second palette. Your existing light / dark / system preference keeps working, and the glass picks that side's opacity and rim strength automatically.

## Controls

Settings → General → **Liquid glass**:

- **Switch** — enable or disable the whole theme; off returns the interface exactly to the host's own appearance
- **Wallpaper** — drop an image or click to choose; PNG / JPEG / WebP / GIF / AVIF, 12 MB max, long edges above 2560px are downscaled before upload
- **Wallpaper strength** — 0–100%, how much the base color dims the wallpaper
- **Glass blur** — 0–40px, affects the composer, dialogs, and the window-level blur
- **Gloss** — 0–100%, scales every mirror highlight together (0 = plain frost)
- **Glass opacity** — 0–100%, scales the alpha of every surface; 0 = bare wallpaper, 100 = full thickness

## Where the wallpaper lives

The Host writes the image to disk; the browser only keeps the file name:

```
POST /api/liquid-glass/wallpaper   { data: dataURL }  -> { file: "wall-<hash>.jpg" }
POST /api/liquid-glass/wallpaper   { clear: true }    -> { file: null }
GET  /api/liquid-glass/wallpaper/<file>               -> image bytes
```

| Item | Value |
| --- | --- |
| Directory | `$DSH_HOME/liquid-glass/wallpapers/` |
| File name | `wall-<first 16 hex of sha256>.<ext>`, content addressed |
| Retention | the 4 most recent images, older ones pruned |
| localStorage | file name and the two slider values only |

Content addressing reuses an identical upload instead of piling up copies. `GET` accepts only `^wall-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$`, so `current.json`, `../`, absolute paths, and `.svg` are all rejected; that blocks path traversal and script-bearing SVG. `POST` requires the same origin and a JSON content type, so another web page cannot drive writes to local disk through a no-preflight request.

## Publishing

Checked against [`docs/user/develop/basic/publish.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md):

| Requirement | This package |
| --- | --- |
| `dsh.bundle.patch` names the patch file | `./cordis.patch.yml` |
| Patch rows reference the plugin by **package name** | `name: dsh-theme-liquid-glass` |
| `engines.dsh` SemVer range | `>=0.2.0-rc.2 <0.3.0` (running 0.2.2-rc.5) |
| `private: true` blocks `pnpm publish` | removed |
| Publishable package name | `@local/*` replaced with `dsh-theme-liquid-glass` |
| `files` covers every runtime file | index/client/patch/locale/docs/icon/README/LICENSE |

**The trap when renaming the package**: the `id` in `client.js`'s `__ModuleLoader__.load({ id })` must match the package name exactly. The module table keys each browser bundle by the package name in `dsh.client`, so a stale id registers a row nothing requests — the plugin silently never runs, its settings row disappears, and the token layer stops applying, while the Host side looks perfectly healthy and still reports `application: applied`. **Toggle the plugin off and on after a rename**; hot reload will not replace an already materialized module.

## Trade-offs

- **Canvas tokens must stay at alpha 0.** The host's frame, `frame::before`, sidebar column, sidebar root, center column, and conversation root each paint the same canvas color, but the number of stacked layers differs per region: the Windows caption band stacks four, the body stacks two. Any translucency loses a share per layer, so differing layer counts expose a hard edge. At alpha 0.14 the seam was still 49/255; only 0 collapses it to nothing. The cost is that panels no longer cover the wallpaper, so type sits directly on the image and `body::before` must keep a scrim (0.30 light / 0.38 dark with a wallpaper).
- **The sidebar is not blurred.** Its container holds `position: fixed` menus and notices, and adding `backdrop-filter` to it would create a containing block and move every one of those overlays. The sidebar is only made translucent; blur goes to the composer and the settings dialog.
- **The settings dialog blurs through a pseudo-element.** The dialog itself still has non-portaled `position: fixed` tooltips inside it and `overflow: hidden`, so the blur is painted on `::before` instead, keeping the containing block on that child layer.
- **The composer's sheen is a `background-image`.** In the no-workspace trigger state the host keeps `::after` for its dashed outline, so a second pseudo-element would collide; a diagonal gradient on the background gives the glass its reflection without creating another stacking context.
- **Strength dims the wallpaper, not the page.** Lowering the whole layer's opacity made text contrast depend on whichever image the user picked; a same-color scrim over the wallpaper thins it while contrast stays stable.
- **Wallpaper and gradient are two looks.** With a wallpaper the scrim drops to a light value, because the photo is the thing to look at; without one, the gradient keeps its original scrim.
- **Photos compress, transparency does not.** Only JPEG/AVIF uploads are re-encoded; PNG, GIF, and WebP keep their format so transparency, animation, and text stay intact.
- **The three window buttons cannot be changed.** They are Electron's native `titleBarOverlay` child window, outside the DOM. The main process forwards the alpha of `--dsw-specific-sidebar-fill` to it, so setting that token to 0 joins the DOM caption with the wallpaper; the native window still paints a layer of its own that no page CSS can reach.
- **macOS menu backing must be opaque.** Chromium can only blur page content over a transparent window when opaque pixels sit behind the page, so `[data-menu-backing]` is rebound to a solid color.
- With `prefers-reduced-motion: reduce` the drift and control transitions stop; with `prefers-reduced-transparency: reduce` the blur is removed and the glass becomes near-opaque.

## What this cannot do

This release is the practical ceiling of "override tokens plus inject a stylesheet". Going further means changing host structure, which a plugin cannot reach:

- **No window-level backdrop sampling.** `backdrop-filter` on `#root` creates a new backdrop root, so every descendant samples `#root` itself instead of the wallpaper and loses its frost at once. The settings panel is portalled to `body`, outside `#root`, so it keeps working — which reads as "only the settings screen still does anything". Window-level depth comes from the scrim and undertone only.
- **The canvas cannot be tinted through its tokens.** The frame, `frame::before`, the sidebar column, the sidebar root, the center column, and the conversation root each paint the same canvas colour, and the number of layers differs per region, so any translucency draws a hard edge. The canvas colour is painted once, in `body::after`.
- **The sidebar cannot be blurred.** Its container holds `position: fixed` menus and notices; `backdrop-filter` there would create a containing block and move them.
- **The three window buttons cannot be changed.** Electron's `titleBarOverlay` is a native child window; page CSS cannot reach its background.
- **No true refraction or reflection.** The edge refraction in Glassmorphism demos needs an SVG displacement filter or WebGL, plus control over the host's stacking structure. Token overrides get you blur, translucency, and highlights — that is the material's ceiling here.

## Measured

Sampled from a live 1920×1032 light-theme window over an illustrated wallpaper:

| Check | Before | After |
| --- | --- | --- |
| Caption boundary (y=39 → y=40) | Δ17/255 hard edge | 1–2/255, gradient noise |
| Caption vs body tone (x=1400) | 199 vs 215 | 209 vs 210 |
| Native button area vs left caption | 226 vs 199 (white bar) | 214 vs 209 |
| Composer card vs surrounding canvas | barely separated | 238 vs 210 |
| Hairline divider between sidebar and body | present | preserved |