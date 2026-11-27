# 液态玻璃（Liquid glass）

[English](DETAIL.md) | 中文

给 DeepSeek Harness Web GUI 铺一层壁纸，把面板换成半透明玻璃材质。

## 它做了什么

三层效果叠在一起，互不覆盖：

| 层 | 实现 | 观感 |
| --- | --- | --- |
| 背景 | 壁纸（或自带的冷色渐变）+ 三团缓慢漂移的彩色光晕，画在 `body` 的负层级伪元素上 | 底色会呼吸，不是一块死渐变 |
| 表面 | 通过主题服务把宿主的别名底色换成半透明值 | 侧栏、消息区、卡片都能透出底下的壁纸 |
| 材质 | 输入框卡片、设置弹窗加 `backdrop-filter` 模糊，再补一层亮边内阴影 | 磨砂玻璃，边缘反光 |

配色只替换宿主的 `--dsw-alias-*` 别名底色，**没有**另起一套调色板。所以你原来的「浅色 / 深色 / 跟随系统」偏好照旧生效，切换时玻璃会自动换用那一侧的透明度与亮边强度。

## 怎么调

设置 → 通用 → **液态玻璃**：

- **开关**：整体启用 / 关闭，关掉即完全回到宿主外观
- **壁纸**：拖入图片或点击选择；支持 PNG / JPEG / WebP / GIF / AVIF，单张上限 12 MB，超过 2560px 的长边会先降采样再上传
- **壁纸浓度**：0–100%，控制壁纸被底色蒙住的多少
- **玻璃模糊**：0–40px，同时调节模糊半径与饱和度

## 壁纸存在哪

图片由 Host 落盘，浏览器只记文件名：

```
POST /api/liquid-glass/wallpaper   { data: dataURL }  -> { file: "wall-<16位哈希>.jpg" }
POST /api/liquid-glass/wallpaper   { clear: true }    -> { file: null }
GET  /api/liquid-glass/wallpaper/<file>               -> 图片字节
```

| 项目 | 值 |
| --- | --- |
| 存放目录 | `$DSH_HOME/liquid-glass/wallpapers/` |
| 文件名 | `wall-<sha256 前 16 位>.<ext>`，内容寻址 |
| 保留数量 | 最近 4 张，超出自动清理 |
| localStorage | 只存文件名与两个滑杆数值 |

用内容哈希做文件名有两个好处：同一张图重复上传直接复用，目录不会越存越多；`GET` 只接受 `^wall-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$`，`current.json`、`../`、绝对路径、`.svg` 一律拒绝，避免路径穿越与 SVG 携带脚本。`POST` 要求同源且声明 JSON，别的网页无法用「免预检的简单请求」往本地磁盘写图。

## 发布

按 [`docs/user/develop/basic/publish.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md) 的规范：

| 要求 | 本包 |
| --- | --- |
| `dsh.bundle.patch` 指向 patch 文件 | `./cordis.patch.yml` |
| patch 行按**包名**引用插件 | `name: dsh-theme-liquid-glass` |
| `engines.dsh` SemVer 范围 | `>=0.2.0-rc.2 <0.3.0`（当前运行 0.2.2-rc.5） |
| `private: true` 会阻止 `pnpm publish` | 已移除 |
| 包名可发布 | 由 `@local/*` 改为 `dsh-theme-liquid-glass` |
| `files` 覆盖全部运行时文件 | index/client/patch/locale/docs/icon/README/LICENSE |

**改包名时最容易踩的坑**：`client.js` 里 `__ModuleLoader__.load({ id })` 的 `id` 必须与包名逐字相同。模块表按 `dsh.client` 声明的包名给每个浏览器 bundle 建行，`id` 写旧名会注册一条没人要的行——插件静默不运行，设置行消失、token 层也不生效，而 Host 侧一切正常、`application: applied` 照旧返回。**改名之后必须重新启用一次插件**，热更新不会替你换掉已经物化的旧模块。

## 已知取舍

- **画布层 alpha 必须为 0**。宿主的 frame、frame::before、侧栏列、侧栏根、centerCol、会话根会各自铺一遍同一个画布色，而每块区域叠的层数并不相同：Windows 标题栏 40px 那一条叠四层、正文只叠两层。半透明时每多一层就多损失一截，叠层数一有差就露出硬边。实测 0.14 时仍差 49/255，只有 0 才归零。代价是面板不再吃字，文字直接落在壁纸上，所以 `body::before` 的蒙版必须留一层（有壁纸时浅色 0.30 / 深色 0.38）。
- **侧栏不加模糊**。侧栏容器里挂着 `position: fixed` 的菜单与提示层，给它加 `backdrop-filter` 会创建 containing block，把那些浮层的定位上下文整个挪走。所以侧栏只做半透明，模糊留给输入框与设置弹窗。
- **设置弹窗的模糊画在伪元素上**。弹窗内部还有未 portal 的 `position: fixed` 气泡（宿主的 Tooltip 默认不 portal），而且弹窗本身 `overflow: hidden`，直接加模糊会让这些气泡偏移并被裁掉；改成 `::before` 承载模糊后，containing block 只落在那一层。
- **输入框的光泽走 `background-image`**。卡片在无工作区的触发态把 `::after` 留给了宿主的虚线外框，再用伪元素会打架；叠一层对角柔光既有玻璃反光，又不额外创建层叠上下文。
- **浓度只压壁纸，不压整页**。早期做法是降低整层的不透明度，结果是文字对比度随用户挑的图崩掉；现在改为在壁纸上叠一层与底色同色的蒙版，观感变淡但对比度稳定。
- **有壁纸与没壁纸是两套观感**。有壁纸时蒙版降到很轻，因为照片本身就是要看的东西；没有壁纸时渐变仍按原来的浓度被压住。
- **照片才压缩，透明不压缩**。只有 JPEG / AVIF 会被重编码；PNG、GIF、WebP 保持原格式，透明度、动画与截图上的文字都不会走样。
- **右上角三个按钮改不了**。它们是 Electron 的 `titleBarOverlay` 原生子窗口，不在 DOM 里。主进程会把 `--dsw-specific-sidebar-fill` 的 alpha 下发给它，所以把这个 token 设为 0 之后，DOM 侧的标题栏已与壁纸连成一片；那个原生窗口自身仍会画一层底色，页面 CSS 无法介入。
- **后端菜单在 macOS 上必须是实色**。Chromium 只有在页面内容背后有实色像素时才能在原生透明窗口上模糊，所以 `[data-menu-backing]` 单独重绑成不透明色。
- 减少动态效果（`prefers-reduced-motion`）时，光晕漂移与控件过渡都会停下；系统要求降低透明度（`prefers-reduced-transparency`）时模糊归零、玻璃退成接近实色。

## 实测

在 1920×1032、浅色主题、带动漫壁纸的实际界面上取样：

| 检查 | 改前 | 改后 |
| --- | --- | --- |
| 标题栏边界（y=39 → y=40） | Δ17/255 硬边 | 1–2/255，属渐变噪声 |
| 标题栏与正文色调（x=1400） | 199 vs 215 | 209 vs 210 |
| 右上角原生按钮区 vs 左侧标题栏 | 226 vs 199（白条） | 214 vs 209 |
| 输入框卡片 vs 卡片外底色 | 区分不足 | 238 vs 210 |
| 侧栏与正文之间的发丝分界线 | 存在 | 保留 |