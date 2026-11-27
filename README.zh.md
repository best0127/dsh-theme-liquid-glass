# 液态玻璃 Liquid glass

[English](README.md) | 中文

给 DeepSeek Harness 的 Web GUI 铺一层壁纸，并把面板换成半透明玻璃材质。设置 → 通用 → 液态玻璃 里开关与调节。

## 安装

```sh
dsh plugin --profile <name> add github:best0127/dsh-theme-liquid-glass
```

或发布到 npm 后 `dsh plugin --profile <name> add dsh-theme-liquid-glass`。

纯 JavaScript，没有构建步骤，因此 git 安装不需要 `prepare` 授权；`lib/` 之类的产物不存在，`main` 直接指向 `index.js`。

## 效果

- **背景**：壁纸 + 三团缓慢漂移的冷色光晕，画在 `body` 的负层级伪元素上，不插入任何 DOM
- **表面**：通过 `ctx.theme.overrideTokens` 把宿主的 `--dsw-alias-*` 别名底色换成半透明值，浅色/深色各一套
- **材质**：输入框卡片与设置弹窗加 `backdrop-filter` 磨砂 + 亮边内阴影

## 可调项

| 控件 | 范围 | 作用 |
| --- | --- | --- |
| 开关 | — | 关掉即完全回到宿主外观 |
| 壁纸 | PNG/JPEG/WebP/GIF/AVIF，≤12 MB | 拖入或点击选择；留空用自带渐变底 |
| 壁纸浓度 | 0–100% | 壁纸被底色蒙住多少 |
| 玻璃模糊 | 0–40px | 模糊半径与饱和度 |

## 壁纸位置

`$DSH_HOME/liquid-glass/wallpapers/`，文件名是内容哈希，保留最近 4 张。浏览器 localStorage 只记文件名与滑杆数值。

详细实现与取舍见 [docs/DETAIL.zh.md](docs/DETAIL.zh.md) / [English](docs/DETAIL.md)。