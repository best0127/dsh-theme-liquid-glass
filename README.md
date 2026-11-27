# Liquid glass

English | [中文](README.zh.md)

Lays a wallpaper under the DeepSeek Harness Web GUI and turns the panels into translucent glass. Everything is configured in Settings → General → Liquid glass.

## Install

```sh
dsh plugin --profile <name> add github:best0127/dsh-theme-liquid-glass
```

Or, once published to npm: `dsh plugin --profile <name> add dsh-theme-liquid-glass`.

Plain JavaScript with no build step, so a git install needs no `prepare` approval. There is no `lib/` output; `main` points straight at `index.js`.

## What it looks like

- **Background** — the wallpaper plus three slowly drifting color glows, painted on negative-z-index pseudo-elements of `body`; no extra DOM is inserted.
- **Surfaces** — `ctx.theme.overrideTokens` replaces the host's `--dsw-alias-*` background aliases with translucent values, one set per color scheme.
- **Material** — the composer card and the settings dialog get a `backdrop-filter` frost plus rim highlights.

## Controls

| Control | Range | Effect |
| --- | --- | --- |
| Switch | — | off returns the interface exactly to the host's own appearance |
| Wallpaper | PNG/JPEG/WebP/GIF/AVIF, ≤12 MB | drop or pick a file; empty uses the built-in gradient |
| Wallpaper strength | 0–100% | how much the base color dims the wallpaper |
| Glass blur | 0–40px | blur radius and saturation |

## Where the wallpaper lives

`$DSH_HOME/liquid-glass/wallpapers/`. File names are content hashes and the four most recent images are kept. Browser localStorage holds only the file name and the two slider values.

Implementation notes and trade-offs: [docs/DETAIL.md](docs/DETAIL.md) / [中文](docs/DETAIL.zh.md).