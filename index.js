/**
 * Host 半边：自定义壁纸的落盘与读取。
 *
 *   POST /api/liquid-glass/wallpaper  { data: dataURL } -> { file: "wall-<hash>.jpg" }
 *   POST /api/liquid-glass/wallpaper  { clear: true }   -> { file: null }
 *   GET  /api/liquid-glass/wallpaper/<file>             -> 图片字节
 *
 * 壁纸不进 localStorage：base64 膨胀 4/3，一张 2 MB 的图要 2.8 M 字符，
 * 撞上配额只会静默失败。前端只存文件名，读图走这条路由。
 *
 * 只依赖 node: 内置模块 —— 本包以本地目录 link 进 profile，Node 从插件目录
 * 解析依赖时看不到 profile 的 node_modules。
 */

import { readFile, writeFile, mkdir, unlink, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const name = 'liquid-glass'

/** 路由提供壁纸能力；缺了它插件保持未激活，而不是抛异常拖挂 profile。 */
export const inject = ['webServer']

const ROUTE = '/api/liquid-glass/wallpaper'
const PREFIX = `${ROUTE}/`
/** 单张图上限 12 MB。 */
const MAX_BYTES = 12 * 1024 * 1024
/** 同时保留几张历史图片。 */
const MAX_FILES = 4
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
}
const NAME_PATTERN = /^wall-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  const selected = typeof fromEnv === 'string' && fromEnv.trim().length > 0
    ? fromEnv
    : path.join(os.homedir(), '.dsh')
  return path.resolve(expandHome(selected))
}

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* 客户端已断开 */
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        const error = new Error('请求体过大')
        error.status = 413
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseDataUrl(value) {
  const matched = /^data:([\w.+/-]+);base64,([\s\S]+)$/.exec(String(value ?? ''))
  if (!matched) {
    const error = new Error('不是合法的 data URL')
    error.status = 400
    throw error
  }
  const mime = matched[1].toLowerCase()
  const ext = MIME_EXT[mime]
  if (!ext) {
    const error = new Error(`不支持的图片类型：${mime}`)
    error.status = 415
    throw error
  }
  const buffer = Buffer.from(matched[2], 'base64')
  if (buffer.length === 0) {
    const error = new Error('图片内容为空')
    error.status = 400
    throw error
  }
  if (buffer.length > MAX_BYTES) {
    const error = new Error(`图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`)
    error.status = 413
    throw error
  }
  return { buffer, ext, mime }
}

export function apply(ctx) {
  const dir = path.join(resolveDshHome(), 'liquid-glass', 'wallpapers')
  const currentFile = path.join(dir, 'current.json')
  const origin = (() => {
    try {
      return new URL(ctx.webServer.getOrigin()).origin
    } catch {
      return undefined
    }
  })()

  /**
   * 写入口只接受同源、且声明 JSON 的请求。localhost 的端口仍可被任意网页用
   * 「简单请求」（text/plain、无预检）打到，不拦就等于允许第三方页面往用户
   * 磁盘写 12 MB × 4 张图。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {boolean} 是否放行。
   */
  function isSameOriginJson(req) {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    const declared = req.headers.origin
    if (typeof declared === 'string' && origin !== undefined && declared !== origin) return false
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    return type === 'application/json'
  }

  async function readCurrent() {
    try {
      const parsed = JSON.parse(await readFile(currentFile, 'utf8'))
      return parsed && NAME_PATTERN.test(parsed.file) ? parsed.file : null
    } catch {
      return null
    }
  }

  async function writeCurrent(file) {
    await mkdir(dir, { recursive: true })
    await writeFile(currentFile, JSON.stringify({ file, updatedAt: new Date().toISOString() }), 'utf8')
  }

  /** 保留当前图加最近几张，其余删掉。 */
  async function prune(keep) {
    try {
      const files = (await readdir(dir)).filter(file => NAME_PATTERN.test(file))
      if (files.length <= MAX_FILES) return
      const stamped = await Promise.all(files.map(async (file) => {
        try {
          return { file, time: (await stat(path.join(dir, file))).mtimeMs }
        } catch {
          return { file, time: 0 }
        }
      }))
      stamped.sort((left, right) => right.time - left.time)
      for (const { file } of stamped.slice(MAX_FILES)) {
        if (file === keep) continue
        await unlink(path.join(dir, file)).catch(() => {})
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  const handler = async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '', 'http://localhost').pathname

      if (req.method === 'GET' || req.method === 'HEAD') {
        const name = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : ''
        if (!NAME_PATTERN.test(name)) return sendJson(res, 400, { ok: false, error: '文件名不合法' })
        let bytes
        try {
          bytes = await readFile(path.join(dir, name))
        } catch {
          return sendJson(res, 404, { ok: false, error: '壁纸不存在' })
        }
        const type = Object.entries(MIME_EXT).find(([, ext]) => ext === path.extname(name))?.[0]
          ?? 'application/octet-stream'
        res.writeHead(200, {
          'content-type': type,
          'content-length': bytes.length,
          // 文件名是内容哈希，可以长期缓存
          'cache-control': 'public, max-age=31536000, immutable',
        })
        res.end(req.method === 'HEAD' ? undefined : bytes)
        return
      }

      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 GET / HEAD / POST' })
      if (!isSameOriginJson(req)) return sendJson(res, 403, { ok: false, error: '仅接受同源的 JSON 请求' })

      const raw = await readBody(req, MAX_BYTES * 2)
      let payload
      try {
        payload = raw.trim() ? JSON.parse(raw) : {}
      } catch {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      }

      if (payload?.clear === true) {
        const previous = await readCurrent()
        await writeCurrent(null)
        if (previous) await unlink(path.join(dir, previous)).catch(() => {})
        return sendJson(res, 200, { ok: true, file: null })
      }

      const { buffer, ext } = parseDataUrl(payload?.data)
      const file = `wall-${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}${ext}`
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, file), buffer)
      await writeCurrent(file)
      await prune(file)
      return sendJson(res, 200, { ok: true, file, bytes: buffer.length })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      if (status >= 500) console.error('[liquid-glass]', error)
      return sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
    }
  }

  // 路由随插件卸载自动移除。
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'liquid-glass: wallpaper route')
}