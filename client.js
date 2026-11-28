/**
 * Client 半边：液态玻璃主题。
 *
 * 三条通道，不互相覆盖
 * --------------------
 * 1. 表面配色：`ctx.theme.overrideTokens(source, tokens)` 叠一层 token 覆盖。
 *    它只把宿主的别名底色换成半透明，每个 token 同时给 light / dark 两个值，
 *    所以用户原来的「浅色 / 深色 / 跟随系统」偏好照旧生效；卸载即还原。
 * 2. 材质：本包自有样式表，`html[data-lg="on"]` 前缀，只给「背后就是壁纸、
 *    且不含 fixed 后代」的表面加 backdrop-filter。给带 fixed 后代的容器加
 *    backdrop-filter 会创建 containing block，把宿主菜单/弹层的定位上下文
 *    整个挪走 —— 所以侧栏与会话根这类容器一律不加模糊。
 * 3. 背景：壁纸、渐变与光晕画在 body 的负层级伪元素上，不插入任何 DOM。
 *    宿主给 body 设了不透明底色，必须先让出来，否则背景层被盖死 —— 这正是
 *    「图传上去了却看不见」的唯一原因。
 *
 * 偏好存 localStorage（纯外观，不进会话日志，也不跨机器同步）。
 */

window.__ModuleLoader__.load({
  // Must equal the package name exactly: the module table keys each dynamic
  // bundle by the package name in `dsh.client`, so a stale id here registers
  // a row nothing asks for and the plugin silently never runs.
  id: 'dsh-theme-liquid-glass',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'liquid-glass'
    const STORAGE_KEY = 'dsh-liquid-glass/v1'
    /** <html> 上的总开关属性；样式表只认它。 */
    const ATTR = 'data-lg'
    /** <html> 上「当前有壁纸」的标记；压光蒙版按它切换强度。 */
    const WALL_ATTR = 'data-lg-wall'
    /** overrideTokens 的层名；固定一个，重复应用就是整层替换。 */
    const LAYER = 'liquid-glass'
    const ENDPOINT = '/api/liquid-glass/wallpaper'
    const MAX_BYTES = 12 * 1024 * 1024
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
    const NAME_PATTERN = /^wall-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/
    /** 上传前的降采样上限；再大的图当壁纸没有收益，只会拖慢首帧。 */
    const MAX_EDGE = 2560
    const JPEG_QUALITY = 0.86
    /** 写在 <html> 上的变量；卸载时逐个撤回。 --lg-cover-pct 是百分比字符串，
     *  在 body 上参与 color-mix，所以不能替换成颜色写在 html 上（var(--lg-base)
     *  在 html 处还没有值）。 */
    const ROOT_VARIABLES = ['--lg-wallpaper', '--lg-cover-pct', '--lg-blur', '--lg-saturate']

    const DEFAULT_WALLPAPER = 92
    const DEFAULT_BLUR = 22
    /** 柔光强度百分比；0 = 只磨砂不反光，100 = 镜面感最强。 */
    const DEFAULT_GLOSS = 70
    /** 玻璃浓度：所有表面 alpha 的统一倍率。 */
    const DEFAULT_OPACITY = 100
    const DEFAULTS = Object.freeze({ on: true, wallpaper: '', strength: DEFAULT_WALLPAPER, blur: DEFAULT_BLUR, gloss: DEFAULT_GLOSS, opacity: DEFAULT_OPACITY })

    // ------------------------------------------------------------ 材质常量

    /**
     * 表面底色与不透明度。底色只是混色基色，真正决定观感的是 alpha。
     *
     * 画布级（base / sidebar）必须是 0 或接近 0：宿主的 frame、frame::before、
     * 侧栏列、侧栏根、centerCol、会话根会各自铺一遍同一个画布色，半透明时
     * 每多一层就多损失一截透明度，而每块区域叠的层数并不相同 —— Windows 标题
     * 栏 40px 那一条叠四层、正文只叠两层，于是出现一条硬边（实测 Δ17/255）。
     * 让画布层完全不铺色，层数差就归零，壁纸也不会被几层色膜挡在后面。
     * 唯一那层蒙版由 body::before 铺一次。
     *
     * 卡片级（layer / overlay / input / menu）是离散表面，只叠一两层，
     * 保持较高 alpha 才能压住文字。
     */
    const SURFACES = {
      light: {
        base: ['#F4F7FE', 0],
        // 卡片层。不能太透：46 处把它当背景用（轨迹表、文件树、会话面板，
        // 以及「已编辑 N 个文件」那种卡片），0.15 会让卡片四周的壁纸直接
        // 穿进来，读起来就是「漏了」。0.42 是既能看见壁纸、又能当一张片子
        // 的程度；画布那几个大容器另外重绑成完全透明（见 CANVAS 规则）。
        layer1: ['#FFFFFF', 0.32],
        layer2: ['#FFFFFF', 0.40],
        overlay: ['#FFFFFF', 0.52],
        sidebar: ['#FFFFFF', 0],
        input: ['#FFFFFF', 0.28],
        menu: ['#FFFFFF', 0.52],
        floating: ['#FFFFFF', 0.74],
        mask: 0.2,
      },
      dark: {
        base: ['#12141C', 0],
        layer1: ['#1B1E28', 0.34],
        layer2: ['#252935', 0.42],
        overlay: ['#2B3040', 0.52],
        sidebar: ['#161923', 0],
        input: ['#1A1D26', 0.30],
        menu: ['#1B1E28', 0.54],
        floating: ['#22252F', 0.76],
        mask: 0.44,
      },
    }

    /**
     * `#rrggbb` 加不透明度 → `rgba()`；上限 0.94，玻璃永远留一线透光。
     * @param {string} hex - `#rrggbb` 形式的颜色。
     * @param {number} alpha - 0–1。
     * @returns {string} 可写进 token 的颜色。
     */
    function withAlpha(hex, alpha) {
      const matched = /^#([0-9a-f]{6})$/i.exec(String(hex))
      if (!matched) return hex
      const value = Number.parseInt(matched[1], 16)
      const rounded = Math.round(Math.min(0.94, Math.max(0, alpha)) * 1000) / 1000
      return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${rounded})`
    }

    /**
     * 生成一层 token 覆盖。一次给出两种配色的完整值：宿主切深浅色时由
     * ThemeRuntime 自己按 active.colorScheme 挑，本插件不必再算一遍。
     * @param {object} prefs - 当前偏好。
     * @returns {Record<string, { light: string, dark: string }>} 覆盖层。
     */
    function tokenLayer(prefs) {
      const light = SURFACES.light
      const dark = SURFACES.dark
      /** 壁纸越淡，表面越可以透；壁纸压得越浓，表面稍收紧以保证文字压得住。 */
      const strength = Math.min(1, Math.max(0, prefs.strength / 100))
      // 玻璃浓度：所有表面 alpha 的唯一倍率。0 = 完全透明（只剩模糊与反光），
      // 100 = 各表面按基准值。之前每个表面写死 alpha，滑杆改不到它们 ——
      // 表现就是「只有壁纸浓度有效，玻璃浓度怎么调都没反应」。
      const opacity = Math.min(1, Math.max(0, prefs.opacity / 100))
      const lift = (1 + (1 - strength) * 0.16) * opacity
      const pick = (table, key) => withAlpha(table[key][0], table[key][1] * lift)
      const blur = Math.round(Math.min(48, Math.max(0, prefs.blur)))
      // 液态玻璃的核心是 saturate 而不是白：把背后的壁纸颜色提纯，透出来的是
      // 更浓的色，而不是被白膜冲淡的灰。blur 只负责「隔着玻璃看」的失焦。
      const glass = `blur(${blur}px) saturate(${190 + Math.round(blur * 1.4)}%) brightness(${1.02})`
      /** gloss 百分比 → 该层高光的实际不透明度。 */
      const glossRatio = Math.min(1, Math.max(0, prefs.gloss / 100))
      const g = (base) => Math.round(base * glossRatio * 1000) / 1000
      return {
        '--dsw-alias-bg-base': { light: pick(light, 'base'), dark: pick(dark, 'base') },
        '--dsw-alias-bg-layer-1': { light: pick(light, 'layer1'), dark: pick(dark, 'layer1') },
        '--dsw-alias-bg-layer-2': { light: pick(light, 'layer2'), dark: pick(dark, 'layer2') },
        '--dsw-alias-bg-layer-3': { light: pick(light, 'layer2'), dark: pick(dark, 'overlay') },
        '--dsw-alias-bg-overlay': { light: pick(light, 'overlay'), dark: pick(dark, 'overlay') },
        '--dsw-specific-sidebar-fill': { light: pick(light, 'sidebar'), dark: pick(dark, 'sidebar') },
        '--dsw-specific-input-major': { light: pick(light, 'input'), dark: pick(dark, 'input') },
        // 浮起的小面板（上下文占用表、提示卡）读这个别名。它们没有菜单那层
        // 实色 backing，在 macOS 原生透明窗口上模糊不可靠，所以留得比菜单实。
        '--dsw-specific-menu': { light: pick(light, 'floating'), dark: pick(dark, 'floating') },
        '--dsw-menu-surface-fill': { light: pick(light, 'menu'), dark: pick(dark, 'menu') },
        '--dsw-menu-backdrop-filter': { light: glass, dark: glass },
        // 玻璃表面读同一个变量：设置行里的模糊滑杆改它，卡片与弹窗一起跟着变。
        '--lg-glass': { light: glass, dark: glass },
        // 镜面扫光。三层叠出体积：左上角一团柔光（光源）、右上角一道窄亮带
        // （玻璃棱边折射）、底部一条冷调反光（环境光托底）。这是「液态」与
        // 「磨砂」的分界 —— 磨砂只有模糊，玻璃自己会反光。
        // gloss 滑杆整体缩放这三层的不透明度，0 就退化成纯磨砂。
        '--lg-sheen': {
          light: `radial-gradient(118% 82% at 16% -12%, rgba(255,255,255,${g(0.92)}) 0%, rgba(255,255,255,${g(0.30)}) 26%, rgba(255,255,255,0) 52%),`
            + ` linear-gradient(122deg, rgba(255,255,255,0) 58%, rgba(255,255,255,${g(0.42)}) 76%, rgba(255,255,255,0) 90%),`
            + ` linear-gradient(0deg, rgba(214,229,255,${g(0.34)}) 0%, rgba(255,255,255,0) 22%)`,
          dark: `radial-gradient(118% 82% at 16% -12%, rgba(255,255,255,${g(0.30)}) 0%, rgba(255,255,255,${g(0.09)}) 26%, rgba(255,255,255,0) 52%),`
            + ` linear-gradient(122deg, rgba(255,255,255,0) 58%, rgba(255,255,255,${g(0.16)}) 76%, rgba(255,255,255,0) 90%),`
            + ` linear-gradient(0deg, rgba(120,168,255,${g(0.16)}) 0%, rgba(255,255,255,0) 24%)`,
        },
        // 贯穿整个窗口的玻璃底：一层极淡的乳白让壁纸"进入玻璃内部"，
        // 再加一道横贯的镜面高光带（液态玻璃最标志性的那条反光）。
        // 这一层把割裂的窗口统一成同一块玻璃；没有它，卡片和背景就是
        // 两种材质拼在一起的观感。
        '--lg-undertone': {
          light: `linear-gradient(168deg, rgba(255,255,255,${g(0.26)}) 0%, rgba(255,255,255,${g(0.10)}) 34%, rgba(255,255,255,${g(0.04)}) 62%, rgba(232,242,255,${g(0.22)}) 100%),`
            + ` radial-gradient(140% 60% at 78% -18%, rgba(255,255,255,${g(0.55)}) 0%, rgba(255,255,255,0) 58%)`,
          dark: `linear-gradient(168deg, rgba(255,255,255,${g(0.07)}) 0%, rgba(255,255,255,${g(0.03)}) 34%, rgba(255,255,255,0) 62%, rgba(90,140,255,${g(0.10)}) 100%),`
            + ` radial-gradient(140% 60% at 78% -18%, rgba(160,200,255,${g(0.16)}) 0%, rgba(255,255,255,0) 58%)`,
        },
        // 画布蒙版：整块侧栏 + 聊天区唯一的一层玻璃色，随「玻璃浓度」缩放。
        // 浓度 0 → 全透明（只剩赤裸壁纸），100 → 基准的 0.62。
        // 之所以走这一层而不是给 bg-base 上色：见上面 CANVAS 的注释，
        // 画布容器会叠 2–4 层同一个色，直接上色必然出现硬边。
        '--lg-veil-base-light': {
          light: `rgba(247, 249, 255, ${Math.round(0.62 * opacity * 1000) / 1000})`,
          dark: `rgba(247, 249, 255, ${Math.round(0.62 * opacity * 1000) / 1000})`,
        },
        '--lg-veil-base-dark': {
          light: `rgba(8, 10, 18, ${Math.round(0.52 * opacity * 1000) / 1000})`,
          dark: `rgba(8, 10, 18, ${Math.round(0.52 * opacity * 1000) / 1000})`,
        },
        // 卡片玻璃的实色底：比 token 更可控，卡片统一读它，
        // 免得本体和头部各读一个 token 又出现色差。
        '--lg-card-glass': {
          light: `rgba(255, 255, 255, ${Math.round(0.38 * opacity * 1000) / 1000})`,
          dark: `rgba(30, 33, 44, ${Math.round(0.46 * opacity * 1000) / 1000})`,
        },
        // 菜单吸顶分组标题压在滚动的菜单项上，必须比菜单本身更实
        '--dsw-alias-menu-group-header-fill': {
          light: 'rgba(255, 255, 255, 0.9)',
          dark: 'rgba(30, 33, 44, 0.9)',
        },
        '--dsw-alias-bg-mask-1': {
          light: `rgba(10, 16, 30, ${light.mask})`,
          dark: `rgba(0, 0, 0, ${dark.mask})`,
        },
        // 用户气泡走一层冷调玻璃，与正文区分开
        '--dsw-specific-bubble': {
          light: 'rgba(96, 152, 255, 0.34)',
          dark: 'rgba(120, 172, 255, 0.34)',
        },
        '--dsw-specific-bubble-highlight': {
          light: 'rgba(96, 152, 255, 0.44)',
          dark: 'rgba(120, 172, 255, 0.42)',
        },
        // 投影的发丝描边换成亮边：玻璃面靠这道高光与背后的壁纸分开
        '--dsw-elevation-stroke-color': {
          light: 'rgba(255, 255, 255, 0.68)',
          dark: 'rgba(255, 255, 255, 0.16)',
        },
        '--dsw-alias-card-fill': {
          light: `rgba(255, 255, 255, ${Math.round(0.30 * opacity * 1000) / 1000})`,
          dark: `rgba(30, 33, 44, ${Math.round(0.34 * opacity * 1000) / 1000})`,
        },
        '--dsw-alias-card-fill-hover': {
          light: `rgba(255, 255, 255, ${Math.round(0.42 * opacity * 1000) / 1000})`,
          dark: `rgba(40, 44, 58, ${Math.round(0.44 * opacity * 1000) / 1000})`,
        },
        // 设置里的下拉/选择器底、回到底部按钮、侧栏选中行、实心 hover：
        // 这几个不换成半透明，玻璃界面上就会嵌出几块实色补丁。
        '--dsw-alias-bg-module-platform': { light: pick(light, 'layer1'), dark: pick(dark, 'layer1') },
        '--dsw-specific-selector': { light: pick(light, 'layer1'), dark: pick(dark, 'layer1') },
        '--dsw-alias-button-floating-fill': { light: pick(light, 'layer1'), dark: pick(dark, 'layer1') },
        '--dsw-alias-button-floating-hover': { light: pick(light, 'layer2'), dark: pick(dark, 'layer2') },
        '--dsw-alias-interactive-bg-hover-solid': { light: pick(light, 'layer1'), dark: pick(dark, 'layer1') },
        '--dsw-specific-sidebar-nav-item-active': { light: pick(light, 'layer1'), dark: pick(dark, 'layer1') },
        '--dsw-specific-sidebar-nav-item-active-accent': {
          light: 'rgba(65, 118, 230, 0.18)',
          dark: 'rgba(122, 170, 255, 0.20)',
        },
      }
    }

    // ------------------------------------------------------------ 样式表

    const CSS = `
/* 让出画布：宿主给 body 设了不透明底色，不让出来背景层就永远看不见。 */
html[${ATTR}="on"],
html[${ATTR}="on"] body{background-color:transparent !important;}

/* 画布容器不需要在这里重绑：真正的画布是 [data-alias-bg-base] 那几层，
   它们的 token 是 bg-base（本来就是 0）。bg-layer-1 只该用在离散卡片上，
   把它的 alpha 定在 0.42 就是正确做法 —— 之前设 0.15 才导致
   「已编辑 N 个文件」这类卡片全透。
   这一段留白是刻意的：曾想在这里重绑 bg-layer-1，但那会继承给内部卡片，
   反而让卡片重新变透明，方向是错的。 */

/* ------------------------------------------------ 统一玻璃底
 *
 * 割裂的根源：之前给「输入框」「弹窗」「卡片」各自打补丁，而窗口本身
 * 还是清晰壁纸。于是同一屏里有的像玻璃、有的像白纸，互相不挨着。
 *
 * 玻璃之所以是玻璃，是因为所有东西都在同一块玻璃后面。所以这里先铺
 * 一层贯穿整个窗口的玻璃底：壁纸上盖一层极淡的乳白 + 一个柔和的镜面渐变。
 * 之后各个表面只在它上面做更实（卡片）或更透（正文），视觉上就同属一套材质。
 *
 * 这一层画在 #root 上：它天然位于 body::before（壁纸）之上、所有窗口内容
 * 之下，不需要额外的层级技巧。
 */
/* 注意：**不要给 #root 加 backdrop-filter**。
   加了会创建一个新的 backdrop root，它内部所有元素的 backdrop-filter
   就只能采集到 #root 自己（也就是什么都没有），于是输入框、弹窗、卡片
   全部失去玻璃感 —— 而 portal 到 body 的设置面板因为不在 #root 里，
   反而照常工作。这就是「只有设置界面在变化」的成因。
   窗口级别的"隔着玻璃看"由 body::before 的蒙版 + 乳白层完成，不用模糊。 */
html[${ATTR}="on"] #root{
  background-image:var(--lg-undertone);
  background-repeat:no-repeat;
  background-size:cover;
}

/* 画布（侧栏 + 聊天区）的玻璃色。
 *
 * 为什么不像卡片那样直接给 bg-base / sidebar-fill 上色：宿主的 frame、
 * frame::before、sidebarCol、SidebarRoot.root、centerCol、ConversationRoot
 * 会各自铺一遍同一个画布色（Windows 标题栏那条最多叠四层），每层半透明，
 * 叠几层就损失几成，层数还因区域而异 —— 直接上色会立刻出现硬边。
 *
 * 所以画布色只画一次：body::after 这一层已经有了（壁纸 + 光晕 + 蒙版），
 * 这里再叠一层按「玻璃浓度」计算的乳白，正好只有一层，不会有接缝。
 * 它同时让侧栏与聊天区跟着浓度滑杆一起变。 */
html[${ATTR}="on"] body{
  --lg-canvas-veil:var(--lg-canvas-veil-light,rgba(244,247,254,0));
}

/* 背景层：底色在最下，然后是渐变，壁纸压在上面，最上是一层按「浓度」
   加深的基色蒙版。蒙版让壁纸变淡而不是让整页变透明，所以文字对比度
   不取决于用户挑了哪张图。 */
html[${ATTR}="on"] body::before{
  content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
  background-color:var(--lg-base);
  background-image:
    linear-gradient(var(--lg-cover),var(--lg-cover)),
    var(--lg-wallpaper,none),
    linear-gradient(148deg,var(--lg-tint-a),var(--lg-tint-b) 54%,var(--lg-tint-c));
  background-size:cover,cover,cover;
  background-position:center;
  background-repeat:no-repeat;
}

/* 光晕 + 压光蒙版。inset 取负值把画布放大，慢速漂移时四边不会露白。 */
html[${ATTR}="on"] body::after{
  content:"";position:fixed;inset:-22vmax;z-index:-1;pointer-events:none;
  background-image:
    radial-gradient(38vmax 30vmax at 16% 10%, var(--lg-glow-a), transparent 62%),
    radial-gradient(34vmax 28vmax at 84% 6%, var(--lg-glow-b), transparent 60%),
    radial-gradient(44vmax 36vmax at 62% 98%, var(--lg-glow-c), transparent 64%),
    linear-gradient(var(--lg-veil),var(--lg-veil));
  animation:lg-drift 42s ease-in-out infinite alternate;
}
@keyframes lg-drift{
  from{transform:translate3d(-1.2%,-0.8%,0) scale(1.02);}
  to{transform:translate3d(1.4%,1.6%,0) scale(1.08);}
}
@media (prefers-reduced-motion: reduce){
  html[${ATTR}="on"] body::after{animation:none;}
}

/* 有壁纸时压光蒙版要留一层，但要比"只有渐变"时轻得多：照片本身就是要看的。
   留这一层不是为了好看，是为了保证对比度 —— 画布层 alpha 为 0，
   面板不再吃字，文字直接落在壁纸上，一张亮色照片会让浅色主题的正文失守。
   数值不写死在这里：它乘了「玻璃浓度」，由 tokenLayer 每帧输出，
   所以拖浓度滑杆时整块画布（侧栏 + 聊天区）会一起变。
   0.62 是浓度 100% 时的基准；浓度 0 时整层归零，画面回到赤裸的壁纸。 */
html[${ATTR}="on"][${WALL_ATTR}="on"]{
  --lg-veil-light:var(--lg-veil-base-light,rgba(247,249,255,0.30));
  --lg-veil-dark:var(--lg-veil-base-dark,rgba(8,10,18,0.38));
}

/* 玻璃表面。
 *
 * 弹窗有两种来源，必须并集覆盖，用任一单一锚点都会漏：
 *   1. Modal 基元（插件管理器、确认框、版本框）。它的 data-shortcut-modal
 *      只有调用方显式传了才有值，所以不能拿它当判据；Modal 卡片的标题栏里
 *      一定有一个 <h2>（headless 向导里是调用方自己的标题），用它把"卡片"
 *      与"全屏层"分开。
 *   2. 设置面板自绘，不是 Modal：标题是 div.navTitle 而不是 <h2>，
 *      但它带 data-shortcut-modal="settings"。
 * 图片灯箱与 Platform 全屏页也是 role=dialog + aria-modal，但一个是全屏
 * 遮罩、一个是整页，不该加模糊，也正好不满足上面两条。
 */
html[${ATTR}="on"] [data-composer-card]{
  -webkit-backdrop-filter:var(--lg-glass);
  backdrop-filter:var(--lg-glass);
}
html[${ATTR}="on"] [aria-modal="true"]:has(h2),
html[${ATTR}="on"] [data-shortcut-modal="settings"]{
  isolation:isolate;
}
/* 模糊画在伪元素上而不是卡片本体：卡片里有未 portal 的 fixed 气泡
   （宿主 Tooltip 默认不 portal），而卡片本身 overflow:hidden；
   直接加 backdrop-filter 会把那些气泡的定位上下文挪进卡片并裁掉。 */
html[${ATTR}="on"] [aria-modal="true"]:has(h2)::before,
html[${ATTR}="on"] [data-shortcut-modal="settings"]::before{
  content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;
  border-radius:inherit;
  -webkit-backdrop-filter:var(--lg-glass);
  backdrop-filter:var(--lg-glass);
}

/* 会话正文区不再逐个加 blur。之前给 [data-conversation-region="chat"] 加
   backdrop-filter 是无效的：那是滚动容器（overflow-y:auto），模糊只会作用在
   它自己的滚动内容上，采不到背后的壁纸。真正让整块画布"隔着玻璃看"的是
   上面那一层 #root 的 backdrop 采样，以及 body::before 的蒙版。 */

/* 「已编辑 N 个文件」和「交付文件」两类卡片：直接锚到它们自己发布的
   data-* 属性，不依赖内部引用的是哪个 token。它们本体和头部原本读不同的值
   （bg-layer-1 / card-fill / cardPreview），头部会比本体更白，看起来像
   "漏了一块"，所以这里把两者统一成同一块玻璃，并补上亮边。
   注意正文里那行「已编辑 client.js」是 PresentedFileCard（data-presented-file），
   不是 ChangedFiles（data-changed-files），两个都要覆盖。 */
html[${ATTR}="on"] [data-changed-files],
html[${ATTR}="on"] [data-presented-file]{
  /* 回退值必须有：--lg-card-glass 由 token 层写在 body 上再继承下来，
     万一某个时机取不到，background 会退化成 transparent —— 那就是全透。
     rgba(...) 兜底保证最差情况也还是一张玻璃片。 */
  background:var(--lg-card-glass,rgba(255,255,255,0.38));
  -webkit-backdrop-filter:blur(14px) saturate(160%);
  backdrop-filter:blur(14px) saturate(160%);
  box-shadow:
    inset 0 1px 0 var(--lg-rim),
    inset 0 0 0 0.5px var(--lg-rim-soft),
    0 14px 30px -22px var(--lg-drop);
}
html[${ATTR}="on"] [data-changed-files] > button,
html[${ATTR}="on"] [data-presented-file] > button{
  background:transparent;
}

/* 亮边：玻璃的第二层特征。投影继续用宿主的 elevation 组合，只追加内阴影
   与一层外扩柔影。设置弹窗的亮边同理走伪元素，避开它的 overflow:hidden。 */
html[${ATTR}="on"] [data-composer-card]{
  /* 宿主自己在 InputBar 里把这条重绑成 border-l2，深色菜单也在别处重绑成
     border-l3；token 层里那一条因此到不了这两个表面。直接在表面上重绑，
     亮边才真的画在 elevation 的发丝描边上。 */
  --dsw-elevation-stroke-color:var(--lg-rim);
  /* 光泽层走 background-image 叠在底色之上：这是「液态」与「磨砂」的分界 ——
     纯 backdrop-filter 只让背后变糊，加上这一层才有玻璃自身的反光。
     不用伪元素，因为卡片在无工作区的触发态把 ::after 留给了宿主的虚线外框，
     而且伪元素加负 z-index 还得让卡片自建层叠上下文，没有必要。 */
  background-image:var(--lg-sheen,none);
  background-repeat:no-repeat;
  box-shadow:var(--dsw-elevation-soft),
    inset 0 1px 0 var(--lg-rim),
    inset 0 -1px 0 var(--lg-rim-soft),
    inset 0 0 0 0.5px var(--lg-rim-soft),
    0 22px 48px -28px var(--lg-drop);
}
html[${ATTR}="on"] [aria-modal="true"]:has(h2),
html[${ATTR}="on"] [data-shortcut-modal="settings"]{
  --dsw-elevation-stroke-color:var(--lg-rim);
  background-image:var(--lg-sheen,none);
  background-repeat:no-repeat;
  box-shadow:var(--dsw-elevation-prominent),
    inset 0 1px 0 var(--lg-rim),
    inset 0 -1px 0 var(--lg-rim-soft),
    0 30px 70px -40px var(--lg-drop);
}

/* 菜单容器自带一层材质（z-index:-1 的子层），内阴影必须画在材质之上，
   所以走 ::after 而不是容器自身的 box-shadow。 */
html[${ATTR}="on"] [data-menu-material]::after{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  box-shadow:inset 0 1px 0 var(--lg-rim),inset 0 0 0 0.5px var(--lg-rim-soft);
}

/* macOS 的菜单底层必须是实色，Chromium 才能在原生透明窗口上模糊页面内容。 */
html[data-platform="darwin"][${ATTR}="on"] [data-menu-backing]{
  background-color:var(--lg-opaque) !important;
}

/* ------------------------------------------------------------ 窗口按钮区
 *
 * Windows/Linux 的最小化/最大化/关闭按钮由 Electron 的 titleBarOverlay 画在
 * 页面之上，是原生子窗口而不是 DOM。页面 CSS 改不了它的颜色，但主进程会向它
 * 下发 --dsw-specific-sidebar-fill —— 那个 token 现在是 alpha 0，所以 DOM 侧
 * 的标题栏已与壁纸连成一片。原生按钮区背后仍会淡掉一截，这是 Electron 窗口
 * 自身的行为，插件改不了；能保证的是背景层连这 40px 一起铺满，
 * 让透出来的部分也是同一张壁纸，而不是一块纯色。
 */
html[${ATTR}="on"][data-windows-titlebar] body::before{
  inset:0;
}

html[${ATTR}="on"] body{
  --lg-base:#F4F7FE;
  --lg-tint-a:#DCE8FF; --lg-tint-b:#F1ECFF; --lg-tint-c:#E3F5FF;
  --lg-glow-a:rgba(120,168,255,0.34);
  --lg-glow-b:rgba(186,158,255,0.30);
  --lg-glow-c:rgba(120,226,230,0.26);
  --lg-veil:var(--lg-veil-light,rgba(247,249,255,0.40));
  --lg-cover:color-mix(in srgb,var(--lg-base) var(--lg-cover-pct,0%),transparent);
  --lg-rim:rgba(255,255,255,0.80);
  --lg-rim-soft:rgba(255,255,255,0.42);
  --lg-drop:rgba(28,44,86,0.28);
  --lg-opaque:#FFFFFF;
}
html[${ATTR}="on"] body[data-ds-dark-theme]{
  --lg-base:#0B0E16;
  --lg-tint-a:#101C34; --lg-tint-b:#1A1430; --lg-tint-c:#0D2430;
  --lg-glow-a:rgba(64,124,255,0.30);
  --lg-glow-b:rgba(150,96,255,0.26);
  --lg-glow-c:rgba(40,200,214,0.20);
  --lg-veil:var(--lg-veil-dark,rgba(8,10,18,0.54));
  --lg-rim:rgba(255,255,255,0.22);
  --lg-rim-soft:rgba(255,255,255,0.10);
  --lg-drop:rgba(0,0,0,0.55);
  --lg-opaque:#15171F;
}

/* ---------------------------------------------------------------- 设置行 */
.lg-row{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px 0;
  border-bottom:0.5px solid var(--dsw-alias-border-l2);}
.lg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;}
.lg-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);}
.lg-desc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.lg-panel{display:flex;flex-direction:column;gap:12px;}
.lg-wall-row{display:flex;align-items:stretch;gap:8px;}
.lg-drop{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:12px;
  min-height:56px;padding:10px 14px;box-sizing:border-box;
  border-radius:var(--dsw-radius-md);cursor:pointer;
  border:1px dashed var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary);
  transition:border-color 140ms,background-color 140ms;}
/* 悬停效果只在真有悬停指针时生效；拖拽高亮（.lg-over）与键盘焦点条件之外保留。 */
@media (hover: hover){
  .lg-drop:hover{border-color:var(--dsw-alias-brand-primary);
    background:var(--dsw-alias-bg-layer-2);}
  .lg-clear:hover{background:var(--dsw-alias-bg-layer-2);}
}
.lg-drop.lg-over{border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2);}
.lg-drop:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:2px;}
.lg-thumb{width:44px;height:36px;flex:none;border-radius:var(--dsw-radius-sm);
  background-size:cover;background-position:center;
  box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l3);}
.lg-drop-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}
.lg-drop-main{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lg-drop-sub{font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lg-clear{flex:none;align-self:center;height:36px;padding:0 14px;box-sizing:border-box;
  border-radius:var(--dsw-radius-sm);cursor:pointer;font:inherit;font-size:13px;
  border:0.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  transition:background-color 140ms;}
.lg-clear:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:2px;}
/* 开关与宿主 Switch 同一套几何与 token：36×20、内缩 2、胶囊轨道，
   选中走 brand-primary（浅色近黑、深色近白），聚焦走宿主的焦点环写法，
   这样连「指针模态下抑制焦点环」的规则也一起继承。 */
.lg-knob{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;
  padding:2px;border:0;border-radius:999px;corner-shape:round;cursor:pointer;
  background:var(--dsw-alias-border-l3);
  transition:background-color 120ms;}
.lg-knob[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}
.lg-knob::after{content:"";display:block;width:16px;height:16px;
  border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);
  transition:transform 120ms;}
.lg-knob[aria-checked="true"]::after{transform:translateX(16px);
  background:var(--dsw-alias-label-primary-foreground);}
.lg-knob:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:2px;}
.lg-knob:disabled{cursor:default;opacity:.5;}
.lg-sliders{display:flex;flex-wrap:wrap;gap:12px 24px;}
.lg-field{display:flex;align-items:center;gap:10px;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);}
.lg-range{width:132px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;}
.lg-value{min-width:42px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary);}
.lg-error{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary);}
.lg-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}

@media (max-width:600px){
  .lg-head{flex-direction:column;gap:10px;}
  .lg-range{width:96px;}
}
@media (prefers-reduced-motion: reduce){
  .lg-drop,.lg-clear,.lg-knob,.lg-knob::after{transition:none;}
}
/* 系统要求降低透明时，玻璃退成接近不透明的实色：模糊归零、底色拉满。 */
@media (prefers-reduced-transparency: reduce){
  html[${ATTR}="on"] [data-composer-card],
  html[${ATTR}="on"] [aria-modal="true"]:has(h2)::before,
  html[${ATTR}="on"] [data-shortcut-modal="settings"]::before{
    -webkit-backdrop-filter:none;backdrop-filter:none;
  }
  html[${ATTR}="on"] [data-composer-card],
  html[${ATTR}="on"] [aria-modal="true"]:has(h2),
  html[${ATTR}="on"] [data-shortcut-modal="settings"]{
    background-color:var(--lg-base);
  }
}
`

    // ------------------------------------------------------------ 文案

    const ZH = {
      'title': '液态玻璃',
      'description': '在界面下面铺一层壁纸，面板改用半透明玻璃材质。只影响外观，不改动会话内容。',
      'toggle': '启用液态玻璃',
      'wallpaperHint': '拖入图片或点击选择；留空使用自带的渐变底',
      'choose': '选择图片',
      'replace': '更换图片',
      'clear': '移除',
      'strength': '壁纸浓度',
      'blur': '玻璃模糊',
      'gloss': '柔光强度',
      'opacity': '玻璃浓度',
      'uploading': '正在导入…',
      'sizeError': '图片超过 12 MB',
      'typeError': '仅支持 PNG / JPEG / WebP / GIF / AVIF',
      'uploadError': '壁纸保存失败，请重试',
      'clearError': '壁纸删除失败，请重试',
      'dropHint': '松开即可设为壁纸',
    }

    const EN = {
      'title': 'Liquid glass',
      'description': 'Puts a wallpaper under a translucent glass interface. Appearance only; conversation content is untouched.',
      'toggle': 'Enable liquid glass',
      'wallpaperHint': 'Drop an image or click to choose; empty uses the built-in gradient',
      'choose': 'Choose image',
      'replace': 'Replace image',
      'clear': 'Remove',
      'strength': 'Wallpaper strength',
      'blur': 'Glass blur',
      'gloss': 'Gloss',
      'opacity': 'Glass opacity',
      'uploading': 'Importing…',
      'sizeError': 'Image is larger than 12 MB',
      'typeError': 'Only PNG / JPEG / WebP / GIF / AVIF are supported',
      'uploadError': 'Could not save the wallpaper. Try again',
      'clearError': 'Could not remove the wallpaper. Try again',
      'dropHint': 'Release to use as wallpaper',
    }

    // ------------------------------------------------------------ 偏好

    const listeners = new Set()
    let state = { ...DEFAULTS }
    let snapshot = { ...state }

    /**
     * @param {unknown} value - 待收敛的数值。
     * @param {number} min - 下限。
     * @param {number} max - 上限。
     * @param {number} fallback - 非数值时的落点。
     * @returns {number} 范围内的整数。
     */
    function clampNumber(value, min, max, fallback) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return fallback
      return Math.min(max, Math.max(min, Math.round(parsed)))
    }

    /**
     * 收敛存储里的原始值：某个字段坏了只回到该字段的默认，不整份丢弃。
     * @param {unknown} raw - 反序列化结果。
     * @returns {object} 完整偏好。
     */
    function normalize(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        on: source.on !== false,
        wallpaper: typeof source.wallpaper === 'string' && NAME_PATTERN.test(source.wallpaper) ? source.wallpaper : '',
        strength: clampNumber(source.strength, 0, 100, DEFAULT_WALLPAPER),
        blur: clampNumber(source.blur, 0, 40, DEFAULT_BLUR),
        gloss: clampNumber(source.gloss, 0, 100, DEFAULT_GLOSS),
        opacity: clampNumber(source.opacity, 0, 100, DEFAULT_OPACITY),
      }
    }

    /**
     * @returns {object} 上次保存的偏好。
     */
    function readStored() {
      try {
        return normalize(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'))
      } catch {
        return { ...DEFAULTS }
      }
    }

    /**
     * @param {object} next - 要保存的完整偏好。
     */
    function persist(next) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* 配额已满或隐私模式：这一轮照常生效，只是下次启动回到默认 */
      }
    }

    /**
     * 合并一次改动：写存储、换快照、通知订阅者。
     * @param {object} patch - 只含变化的字段。
     */
    function commit(patch) {
      state = { ...state, ...patch }
      snapshot = { ...state }
      persist(state)
      for (const listener of [...listeners]) listener()
    }

    /**
     * @param {() => void} listener - 偏好变化时的回调。
     * @returns {() => void} 取消订阅。
     */
    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /**
     * @returns {object} 引用稳定的当前快照（uSES 要求未变化时同一引用）。
     */
    function getSnapshot() {
      return snapshot
    }

    /**
     * @param {string} file - Host 生成的文件名。
     * @returns {string} 可直接放进 CSS `url()` 的地址。
     */
    function wallpaperUrl(file) {
      return file ? `${ENDPOINT}/${encodeURIComponent(file)}` : ''
    }

    // ------------------------------------------------------------ 落到文档

    let releaseLayer = null
    /** applyLayer 正在改主题层；它引发的 theme/change 回声必须忽略，否则回环。 */
    let applying = false
    /** 待执行的 token 层刷新；滑杆一帧能触发十几次 commit，合并成一帧一次。 */
    let layerFrame = 0

    /**
     * 写根变量与总开关，不碰主题服务，因此任何时刻都可以重复调用。
     *
     * 有壁纸和没壁纸是两套观感，靠 `data-lg-wall` 区分：
     * - 有壁纸：浓度只用于「把壁纸压淡一点」，压光蒙版同时降到很轻 ——
     *   否则 蒙版 × 壁纸浓度 × 层层半透明表面 三项叠乘，照片会糊成一张纸。
     * - 无壁纸：只有自带渐变，渐变本来就该被蒙版压住，维持原来的浓度。
     * @param {object} prefs - 当前偏好。
     */
    function applyPaint(prefs) {
      const root = document.documentElement
      if (!prefs.on) {
        root.removeAttribute(ATTR)
        root.removeAttribute(WALL_ATTR)
        for (const name of ROOT_VARIABLES) root.style.removeProperty(name)
        return
      }
      root.setAttribute(ATTR, 'on')
      root.style.setProperty('--lg-blur', `${prefs.blur}px`)
      root.style.setProperty('--lg-saturate', `${158 + Math.round(prefs.blur * 0.9)}%`)
      // 窗口级别的模糊要跟着同一个滑杆走，但幅度打个折：整窗模糊太强会把
      // 壁纸特征全抹掉，也拖性能。取滑杆的 0.6 倍并夹在 0–16px。
      root.style.setProperty('--lg-root-blur', `${Math.round(Math.min(16, prefs.blur * 0.6))}px`)
      if (prefs.wallpaper) {
        root.setAttribute(WALL_ATTR, 'on')
        root.style.setProperty('--lg-wallpaper', `url("${wallpaperUrl(prefs.wallpaper)}")`)
        root.style.setProperty('--lg-cover-pct', `${100 - prefs.strength}%`)
      } else {
        root.removeAttribute(WALL_ATTR)
        root.style.removeProperty('--lg-wallpaper')
        root.style.removeProperty('--lg-cover-pct')
      }
    }

    /**
     * 叠一层 token 覆盖。只在初始化和偏好变化时调用；theme/change 的回声由
     * `applying` 挡掉，不在这里再次 overrideTokens。
     * @param {object} prefs - 当前偏好。
     * @param {object|undefined} theme - ctx.theme 服务。
     */
    function applyLayer(prefs, theme) {
      applying = true
      try {
        if (releaseLayer) {
          releaseLayer()
          releaseLayer = null
        }
        if (prefs.on && theme) {
          try {
            releaseLayer = theme.overrideTokens(LAYER, tokenLayer(prefs))
          } catch (error) {
            releaseLayer = null
            console.error('[liquid-glass] overrideTokens 失败：', error)
          }
        }
      } finally {
        applying = false
      }
    }

    /**
     * 按当前偏好整体重落一遍。滑杆拖动期间把 token 层合并到下一帧，
     * 所以一次拖动只重铺一次而不是每个 change 事件一次。
     * @param {object} ctx - 浏览器插件上下文。
     * @param {boolean} withLayer - 是否一并重铺 token 层。
     * @param {boolean} deferLayer - 是否把 token 层推后到下一帧。
     */
    function reapply(ctx, withLayer, deferLayer) {
      applyPaint(state)
      if (!withLayer) return
      if (layerFrame !== 0) {
        window.cancelAnimationFrame(layerFrame)
        layerFrame = 0
      }
      if (deferLayer !== true) {
        applyLayer(state, ctx.get('theme'))
        return
      }
      layerFrame = window.requestAnimationFrame(() => {
        layerFrame = 0
        applyLayer(state, ctx.get('theme'))
      })
    }

    // ------------------------------------------------------------ 图片

    /**
     * @param {File} file - 用户挑的文件。
     * @returns {Promise<string>} data URL。
     */
    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('read-failed'))
        reader.readAsDataURL(file)
      })
    }

    /**
     * 大图先降采样再上传：12 MB 的原图当壁纸没有收益，却要多传几秒。
     *
     * 只有照片才转 JPEG。带透明的 PNG、GIF、WebP 一律原样上传 —— canvas 里
     * 透明区会变黑，GIF 会掉帧，截图上的文字会被 JPEG 糊掉，用户看到的就和
     * 选的不一样了。降采样只改尺寸，不改格式。
     * @param {File} file - 用户挑的文件。
     * @returns {Promise<string>} 用于上传的 data URL。
     */
    async function prepareImage(file) {
      const dataUrl = await readAsDataUrl(file)
      if (file.size <= 420 * 1024) return dataUrl
      const lossless = file.type === 'image/png' || file.type === 'image/gif'
      try {
        const image = await new Promise((resolve, reject) => {
          const element = new Image()
          element.onload = () => resolve(element)
          element.onerror = () => reject(new Error('decode-failed'))
          element.src = dataUrl
        })
        const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
        if (scale === 1) return dataUrl
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext('2d')
        if (!context) return dataUrl
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        if (lossless) {
          const png = canvas.toDataURL('image/png')
          // 缩完反而更大（小图或高噪点图）就没必要换了
          if (png.length < dataUrl.length) return png
        } else if (file.type === 'image/jpeg' || file.type === 'image/avif') {
          return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
        }
        return dataUrl
      } catch {
        return dataUrl
      }
    }

    /**
     * 上传壁纸并返回 Host 生成的文件名。
     * @param {File} file - 用户挑的文件。
     * @param {(key: string) => string} t - 本命名空间的翻译。
     * @returns {Promise<string>} 文件名。
     */
    async function uploadWallpaper(file, t) {
      if (!IMAGE_TYPES.includes(file.type)) throw new Error(t('typeError'))
      if (file.size > MAX_BYTES) throw new Error(t('sizeError'))
      const data = await prepareImage(file)
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? t('uploadError'))
      return String(payload.file ?? '')
    }

    /**
     * 删除当前壁纸（含磁盘文件）。
     * @returns {Promise<void>} 完成即表示 Host 已清理。
     */
    async function clearWallpaper() {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      })
      if (!response.ok) throw new Error('clear-failed')
    }

    // ------------------------------------------------------------ 组件

    /**
     * 「通用」设置里的液态玻璃行：开关 + 壁纸 + 两个滑杆。
     * @param {object} props - 槽位 props（locale 座位给 `t`）。
     * @returns {object} 行元素。
     */
    function LiquidGlassRow(props) {
      const { t } = props
      const prefs = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const [busy, setBusy] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const [error, setError] = React.useState('')
      const input = React.useRef(null)

      const pick = async (file) => {
        if (file === undefined || file === null) return
        setBusy(true)
        setError('')
        try {
          commit({ wallpaper: await uploadWallpaper(file, t), on: true })
        } catch (failure) {
          setError(String(failure?.message ?? t('uploadError')))
        } finally {
          setBusy(false)
        }
      }

      const drop = h('div', {
        className: dragging ? 'lg-drop lg-over' : 'lg-drop',
        role: 'button',
        tabIndex: 0,
        'aria-label': prefs.wallpaper ? t('replace') : t('choose'),
        onClick: () => { input.current?.click() },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          input.current?.click()
        },
        onDragOver: (event) => {
          // 宿主的附件 drop 监听装在 document 上，且不看事件归属；这里不切断
          // 冒泡，同一张图会既成为壁纸、又成为待发附件，输入框还会亮起拖放
          // 遮罩。dragenter 一并切断，遮罩才不会先亮。
          event.preventDefault()
          event.stopPropagation()
          setDragging(true)
        },
        onDragEnter: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(true)
        },
        onDragLeave: (event) => {
          event.stopPropagation()
          setDragging(false)
        },
        onDrop: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          void pick(event.dataTransfer?.files?.[0])
        },
      },
      prefs.wallpaper
        ? h('div', { className: 'lg-thumb', style: { backgroundImage: `url("${wallpaperUrl(prefs.wallpaper)}")` } })
        : null,
      h('div', { className: 'lg-drop-text' },
        h('span', { className: 'lg-drop-main' },
          busy ? t('uploading') : dragging ? t('dropHint') : prefs.wallpaper ? t('replace') : t('choose')),
        h('span', { className: 'lg-drop-sub' }, t('wallpaperHint'))))

      const clear = prefs.wallpaper && !busy
        ? h('button', {
          type: 'button',
          className: 'lg-clear',
          onClick: () => {
            setError('')
            void clearWallpaper()
              .then(() => { commit({ wallpaper: '' }) })
              .catch(() => { setError(t('clearError')) })
          },
        }, t('clear'))
        : null

      return h('div', { className: 'lg-row' },
        h('div', { className: 'lg-head' },
          h('div', null,
            h('div', { className: 'lg-title' }, t('title')),
            h('div', { className: 'lg-desc' }, t('description'))),
          h('button', {
            type: 'button',
            className: 'lg-knob',
            role: 'switch',
            'aria-checked': prefs.on ? 'true' : 'false',
            'aria-label': t('toggle'),
            onClick: () => { commit({ on: !prefs.on }) },
          })),
        prefs.on
          ? h('div', { className: 'lg-panel', 'aria-busy': busy ? 'true' : 'false' },
            h('div', { className: 'lg-wall-row' }, drop, clear),
            h('div', { className: 'lg-sliders' },
              h('label', { className: 'lg-field' },
                h('span', null, t('strength')),
                h('input', {
                  className: 'lg-range',
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: prefs.strength,
                  onChange: (event) => { commit({ strength: Number(event.target.value) }) },
                }),
                h('span', { className: 'lg-value' }, `${prefs.strength}%`)),
              h('label', { className: 'lg-field' },
                h('span', null, t('blur')),
                h('input', {
                  className: 'lg-range',
                  type: 'range',
                  min: 0,
                  max: 40,
                  step: 1,
                  value: prefs.blur,
                  onChange: (event) => { commit({ blur: Number(event.target.value) }) },
                }),
                h('span', { className: 'lg-value' }, `${prefs.blur}px`)),
              h('label', { className: 'lg-field' },
                h('span', null, t('gloss')),
                h('input', {
                  className: 'lg-range',
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: prefs.gloss,
                  onChange: (event) => { commit({ gloss: Number(event.target.value) }) },
                }),
                h('span', { className: 'lg-value' }, `${prefs.gloss}%`)),
              h('label', { className: 'lg-field' },
                h('span', null, t('opacity')),
                h('input', {
                  className: 'lg-range',
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: prefs.opacity,
                  onChange: (event) => { commit({ opacity: Number(event.target.value) }) },
                }),
                h('span', { className: 'lg-value' }, `${prefs.opacity}%`))),
            error ? h('div', { className: 'lg-error', role: 'alert' }, error) : null,
            h('input', {
              ref: input,
              className: 'lg-file',
              type: 'file',
              accept: IMAGE_TYPES.join(','),
              tabIndex: -1,
              // opacity:0 不等于隐藏：不加这一条，读屏会把一个没有名字的
              // 「选择文件」念出来。
              'aria-hidden': 'true',
              onChange: (event) => {
                void pick(event.target.files?.[0])
                event.target.value = ''
              },
            }))
          : null)
    }

    // ------------------------------------------------------------ 注册

    return {
      /**
       * theme 必须声明成依赖：只写 slots / locale 时 apply 可能早于 Theme
       * 服务就绪，overrideTokens 整段被跳过，界面会停在宿主默认外观。
       */
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'liquid-glass: dictionaries')

        // 本包自有样式表：随插件卸载一起移除。
        ctx.effect(() => {
          const element = document.createElement('style')
          element.setAttribute('data-plugin', NS)
          element.textContent = CSS
          document.head.appendChild(element)
          return () => { element.remove() }
        }, 'liquid-glass: stylesheet')

        state = readStored()
        snapshot = { ...state }
        reapply(ctx, true)

        // 偏好变化：壁纸与滑杆立即生效，token 层合并到下一帧。
        ctx.effect(() => subscribe(() => { reapply(ctx, true, true) }), 'liquid-glass: preference subscription')

        // 主题服务重建或别的插件改了分层时补一次；本插件自己引起的回声跳过。
        // 这里只在 token 层丢失时重铺 —— 否则会和 overrideTokens 的 publish 回环。
        ctx.effect(() => ctx.on('theme/change', () => {
          if (applying || layerFrame !== 0) return
          if (releaseLayer !== null) return
          reapply(ctx, true)
        }), 'liquid-glass: theme subscription')

        // 主题服务迟到时的兜底：inject 已保证顺序，这里只兜 HMR 与慢启动。
        let attempts = 0
        let timer = 0
        const settle = () => {
          if (ctx.get('theme') !== undefined) {
            if (attempts > 0) reapply(ctx, true)
            return
          }
          if (attempts >= 20) return
          attempts += 1
          timer = window.setTimeout(settle, 150)
        }
        settle()

        // 卸载时把 token 层、根变量与 <html> 属性一起还原。
        ctx.effect(() => () => {
          if (timer) window.clearTimeout(timer)
          if (layerFrame !== 0) {
            window.cancelAnimationFrame(layerFrame)
            layerFrame = 0
          }
          if (releaseLayer) {
            releaseLayer()
            releaseLayer = null
          }
          const root = document.documentElement
          root.removeAttribute(ATTR)
          for (const name of ROOT_VARIABLES) root.style.removeProperty(name)
        }, 'liquid-glass: teardown')

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: NS,
          order: 13,
          locale: NS,
        }, LiquidGlassRow))
      },
    }
  },
})