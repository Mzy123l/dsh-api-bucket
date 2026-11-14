/**
 * dsh-api-bucket —— 把 DeepSeek「全家桶应用 API」注册成模型工具。
 *
 * 覆盖能力（每个都能在设置面板单独开关、单独选提供方）：
 *   · 文件输入（Files API + 对话引用，支持文本/图片/文档解析两种 purpose）
 *   · 阅读链接（POST /v1/tools/fetch）
 *   · 模型安全（chat/completions 的 safety_check）
 *   · OCR（POST /v1/tools/ocr）
 *   · ASR（POST /v1/tools/asr）
 *   · TTS（POST /v1/tools/tts，落成本地 wav 并作为交付物展示）
 *
 * 设计要点：
 *  1. 配置**只**存在每个 Windows 用户自己的 `$DSH_HOME/dsh-api-bucket-profile.json`
 *     （默认 `~/.dsh/dsh-api-bucket-profile.json`）；插件不读也不写 profile 的
 *     cordis.patch.yml。设置面板通过本插件的 `/__dsh_api_bucket__/config` 端点
 *     读写这份 JSON，保存后立即生效（工具用 `when` 读活配置，不需要重启）。
 *  2. 提供方沿用官方 web-deepseek-api 的口径：
 *       auto        —— 跟随当前会话的模型路由（deepseek-account 先用账号，deepseek-official
 *                      只用 API Key，其他路由先 API Key 再账号）
 *       account     —— 只用已登录的 DeepSeek 账号
 *       api-key     —— 只用 DeepSeek API Key
 *     账号令牌走 `x-dsh-auth-token`，API Key 走 `Authorization: Bearer`。
 *  3. 零第三方依赖；只用 Node 内置模块与全局 fetch/FormData/Blob。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-api-bucket'

/** 需要的服务：工具注册必有；账号、凭据、agents、webServer 用可选读取。 */
export const inject = ['tools']

/** 默认 DeepSeek 开放平台基址。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 默认 API Key 的凭据引用名。 */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 文件输入与安全校验用的模型（全家桶能力只在这些模型上提供）。 */
const DEFAULT_MODEL = 'deepseek-flash'

/** 设置面板写入配置的端点。 */
const CONFIG_PATH = '/__dsh_api_bucket__/config'

/** 六个能力，顺序即设置面板的行顺序。 */
const CAPABILITIES = ['file', 'readlink', 'safety', 'ocr', 'asr', 'tts']

/** 各能力的工具名。 */
const TOOL_NAMES = {
  file: 'deepseek_file_input',
  readlink: 'deepseek_read_link',
  safety: 'deepseek_safety_check',
  ocr: 'deepseek_ocr',
  asr: 'deepseek_asr',
  tts: 'deepseek_tts',
}

/** 提供方取值。 */
const PROVIDERS = ['auto', 'account', 'api-key']

/** 代码里的出厂配置。 */
const DEFAULTS = {
  version: 1,
  baseURL: DEFAULT_BASE_URL,
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  file: { enabled: true, provider: 'auto', model: DEFAULT_MODEL },
  readlink: { enabled: true, provider: 'auto' },
  safety: { enabled: true, provider: 'auto', model: DEFAULT_MODEL },
  ocr: { enabled: true, provider: 'auto' },
  asr: { enabled: true, provider: 'auto' },
  tts: { enabled: true, provider: 'auto', voice: 'stella', format: 'wav', outputDir: 'dsh-api-bucket' },
}

/** DSH 用户数据根：默认 `~/.dsh`，`$DSH_HOME` 可覆盖。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 本用户配置文件路径。 */
export function configPath() {
  return path.join(dshHome(), 'dsh-api-bucket-profile.json')
}

/** 深拷贝，避免调用方改到常量。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 把任意读到的值收敛成合法配置：缺项补默认、非法值回落默认。 */
export function normalizeConfig(raw) {
  const out = clone(DEFAULTS)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const text = (value, fallback, allowed) => {
    if (typeof value !== 'string' || value.length === 0) return fallback
    return allowed !== undefined && !allowed.includes(value) ? fallback : value
  }
  out.baseURL = text(raw.baseURL, DEFAULTS.baseURL).replace(/\/+$/u, '')
  out.apiKeyEnv = text(raw.apiKeyEnv, DEFAULTS.apiKeyEnv)
  for (const key of CAPABILITIES) {
    const row = raw[key]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    out[key].enabled = typeof row.enabled === 'boolean' ? row.enabled : out[key].enabled
    out[key].provider = text(row.provider, out[key].provider, PROVIDERS)
    if (key === 'file' || key === 'safety') {
      out[key].model = text(row.model, out[key].model)
    }
    if (key === 'tts') {
      out[key].voice = text(row.voice, out[key].voice, ['stella', 'tide'])
      out[key].format = text(row.format, out[key].format, ['wav', 'pcm'])
      out[key].outputDir = text(row.outputDir, out[key].outputDir)
    }
  }
  return out
}

/** 读配置；文件不存在就用出厂值建一份，读坏了就备份后重建。 */
export function readConfig() {
  const file = configPath()
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const seeded = clone(DEFAULTS)
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8')
      } catch { /* 建不了文件就只用内存默认值，功能不受影响 */ }
      return seeded
    }
    try {
      fs.renameSync(file, `${file}.broken-${Date.now()}`)
    } catch { /* 备份失败不影响继续 */ }
    return clone(DEFAULTS)
  }
}

/** 原子写配置。 */
export function writeConfig(next) {
  const file = configPath()
  const normalized = normalizeConfig(next)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return normalized
}

/** 文件字节上限（照抄官方文档的限制）。 */
const LIMITS = { image: 64 * 1024 * 1024, document: 100 * 1024 * 1024, plain: 32 * 1024 * 1024, audio: 8 * 1024 * 1024 }

/** 文档类扩展名：走解析（text_recognition / rich_layout_recognition）。 */
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx'])

/** 图片扩展名。 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

/** 音频扩展名（ASR 只收 16 位 PCM WAV 与 Ogg Opus）。 */
const AUDIO_EXTENSIONS = new Set(['.wav', '.ogg', '.opus'])

/** 按扩展名归类文件。 */
function classify(file) {
  const ext = path.extname(file).toLowerCase()
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  return 'plain'
}

/** 会话工作目录，用于解析工具参数里的相对路径。 */
function sessionCwd(exec) {
  try {
    return exec?.agent?.session?.header?.cwd ?? process.cwd()
  } catch {
    return process.cwd()
  }
}

/**
 * 读一个本地文件成字节，并做大小校验。
 * 相对路径按当前会话的工作目录解析（不是进程 cwd），与 read/write 等内置工具一致。
 */
async function readLocalFile(file, kind, signal, cwd) {
  signal?.throwIfAborted?.()
  const resolved = path.resolve(cwd ?? process.cwd(), file)
  let info
  try {
    info = await fs.promises.stat(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`文件不存在：${resolved}（相对路径按会话工作目录 ${cwd ?? process.cwd()} 解析）`)
    throw error
  }
  if (!info.isFile()) throw new Error(`不是普通文件：${resolved}`)
  const cap = LIMITS[kind] ?? LIMITS.document
  if (info.size > cap) {
    throw new Error(`文件过大：${resolved} 是 ${info.size} 字节，上限 ${cap} 字节`)
  }
  return { path: resolved, name: path.basename(resolved), bytes: await fs.promises.readFile(resolved), size: info.size }
}

/** 把字节包成 FormData 的文件字段（文件名照传，便于服务端判类型）。 */
function fileField(bytes, filename) {
  return new Blob([bytes], { type: 'application/octet-stream' })
}

/** 读响应里的错误说明。 */
async function errorDetail(response) {
  let message = `HTTP ${response.status}`
  try {
    const text = await response.text()
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text)
        const detail = typeof parsed?.error === 'string'
          ? parsed.error
          : typeof parsed?.error?.message === 'string' ? parsed.error.message : parsed?.message
        if (typeof detail === 'string' && detail.length > 0) return `${message}: ${detail}`
      } catch { /* 非 JSON 就截一段原文 */ }
      return `${message}: ${text.slice(0, 400)}`
    }
  } catch { /* 读不到正文就只报状态码 */ }
  return message
}

/** 会话当前模型路由的 provider，用于 auto 的凭据排序。 */
function conversationProvider(ctx) {
  try {
    const agents = ctx.get('agents')
    return agents?.currentInitiator?.()?.session?.requestContext?.()?.provider
  } catch {
    return undefined
  }
}

/**
 * 解析一次调用要用的凭据与基址，口径与官方 web-deepseek-api 一致。
 * @returns {{ baseURL: string, headers: Record<string, string> }}
 */
async function resolveAuth(ctx, config, provider) {
  const base = config.baseURL || DEFAULT_BASE_URL
  const ref = config.apiKeyEnv || DEFAULT_API_KEY_ENV
  const apiKey = async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      return undefined
    }
    const ambient = process.env[ref]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }
  const accountToken = async (endpoint) => {
    try {
      const token = await ctx.get('deepseekAccount')?.resolveToken(endpoint)
      return typeof token === 'string' && token.length > 0 ? token : undefined
    } catch {
      return undefined
    }
  }

  // 与官方一致的排序规则。
  const route = conversationProvider(ctx)
  let order
  if (provider === 'account') order = ['account']
  else if (provider === 'api-key') order = ['api-key']
  else if (route === 'deepseek-account') order = ['account', 'api-key']
  else if (route === 'deepseek-official') order = ['api-key']
  else order = ['api-key', 'account']

  const tried = []
  for (const kind of order) {
    if (kind === 'api-key') {
      const key = await apiKey()
      if (key !== undefined) return { baseURL: base, headers: { authorization: `Bearer ${key}` } }
      tried.push(`API Key（凭据 ${ref}）`)
      continue
    }
    const token = await accountToken(base)
    if (token !== undefined) return { baseURL: base, headers: { 'x-dsh-auth-token': token } }
    tried.push('已登录的 DeepSeek 账号')
  }
  throw new Error(
    `没有可用的 DeepSeek 凭据。已尝试：${tried.join('、')}。`
    + `请在设置面板把该能力的提供方改成可用的那种，或登录 DeepSeek / 配置 ${ref}。`,
  )
}

/** 发一个 JSON POST 并解析 JSON。 */
async function postJSON(url, headers, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(await errorDetail(response))
  return { response, json: await response.json() }
}

/** 发一个 multipart POST 并解析 JSON。 */
async function postForm(url, headers, buildForm, signal) {
  const form = new FormData()
  buildForm(form)
  const response = await fetch(url, {
    method: 'POST', headers: { ...headers, accept: 'application/json' }, body: form, signal,
  })
  if (!response.ok) throw new Error(await errorDetail(response))
  const text = await response.text()
  if (text.trim().length === 0) throw new Error('服务端返回了空响应')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`服务端返回的不是 JSON：${text.slice(0, 300)}`)
  }
}

/** 从 chat/completions 的响应里取正文与结束原因。 */
function readCompletion(json) {
  const choice = json?.choices?.[0]
  const content = choice?.message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.flatMap((part) => (typeof part?.text === 'string' ? [part.text] : [])).join('') : ''
  return { text, finish: choice?.finish_reason, usage: json?.usage }
}

/** 判断一次安全校验的结果。 */
function safetyVerdict(json) {
  const choice = json?.choices?.[0]
  const finish = choice?.finish_reason
  if (finish === 'content_filter') return { safe: false, reason: '模型判定该内容命中风险（content_filter）' }
  if (json?.stop_reason === 'refusal') return { safe: false, reason: '模型判定该内容命中风险（refusal）' }
  if (finish === 'length') return { safe: true, reason: '审核通过（输出被截断，属正常）' }
  return { safe: true, reason: '审核通过' }
}

/** 把 TTS 音频落盘到会话工作目录下。 */
async function writeAudio(cwd, outputDir, bytes, format, signal) {
  signal?.throwIfAborted?.()
  const dir = path.resolve(cwd, outputDir)
  await fs.promises.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const target = path.join(dir, `tts-${stamp}.${format === 'pcm' ? 'pcm' : 'wav'}`)
  await fs.promises.writeFile(target, bytes)
  return target
}

/** 校验一个工具名对应的能力当前是否开启。 */
function enabled(config, key) {
  return config[key]?.enabled !== false
}

/**
 * 把「属性上标 required: true」这种紧凑写法转成 DSH 接受的 JSON Schema：
 * required 提升为父对象上的名字数组，properties/items/oneOf 递归处理。
 * 这样工具定义既能写得短，又不依赖 defineTool 的编译期辅助。
 * @param {Record<string, unknown>} node - 紧凑写法的一个 schema 节点。
 * @returns {Record<string, unknown>} JSON Schema 节点。
 */
function toJsonSchema(node) {
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue
    if (key === 'properties') {
      const properties = {}
      const required = []
      for (const [name, spec] of Object.entries(value)) {
        if (spec?.required === true) required.push(name)
        properties[name] = toJsonSchema(spec)
      }
      out.properties = properties
      if (required.length > 0) out.required = required
      continue
    }
    if (key === 'items') { out.items = toJsonSchema(value); continue }
    if (key === 'oneOf') { out.oneOf = value.map(toJsonSchema); continue }
    out[key] = value
  }
  return out
}

/** 顶层参数对象的紧凑写法 → JSON Schema。 */
function schemaOf(spec) {
  return toJsonSchema({ type: 'object', properties: spec })
}

/**
 * 注册全部工具、配置端点与交付物事件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  /** 每次调用都读一次配置，设置面板保存后立刻生效。 */
  const config = () => readConfig()

  /** 待交付文件：工具执行结果落定后再写 deliverables/presented 事件。 */
  const pendingDeliveries = new WeakMap()

  /** 六个工具的定义。 */
  const definitions = {
    file: {
      name: TOOL_NAMES.file,
      description: '把本地文件（PDF、Word、PowerPoint、图片、纯文本、表格、电子书）交给 DeepSeek 解析并回答一个问题。'
        + '文档走官方 Files API 的解析 purpose（纯文字或图文混排），图片与纯文本走 user_data，随后在对话中引用 file_id 作答。'
        + '需要文件内容本身时用 read；需要模型基于文件作答时用它。',
      parameters: {
        path: { type: 'string', required: true, description: '本地文件路径；相对路径按当前会话工作目录解析。' },
        question: { type: 'string', required: true, description: '要模型基于该文件回答的问题。' },
        mode: {
          type: 'string', enum: ['auto', 'text', 'layout'], default: 'auto',
          description: '文档解析方式：text 只取文字，layout 保留图表与图片（计入图片数量上限）；auto 按文件类型选。',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            answer: { type: 'string', required: true },
            fileId: { type: 'string', required: true },
            purpose: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            refusal: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.refusal
            ? `DeepSeek 拒答（模型内容安全）：${value.answer || '未返回正文'}`
            : value.answer,
        }],
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const current = config()
        const model = current.file.model || DEFAULT_MODEL
        const auth = await resolveAuth(ctx, current, current.file.provider)
        const kind = classify(args.path)
        const local = await readLocalFile(args.path, kind, exec.signal, sessionCwd(exec))
        const purpose = kind === 'document'
          ? (args.mode === 'layout' ? 'rich_layout_recognition' : 'text_recognition')
          : kind === 'image' || kind === 'plain' ? 'user_data' : 'text_recognition'
        if (kind === 'audio') throw new Error(`${local.name} 是音频文件；语音转写请用 ${TOOL_NAMES.asr}`)

        const uploaded = await postForm(`${auth.baseURL}/files`, auth.headers, (form) => {
          // purpose 必须在 file 之前发送。
          form.append('purpose', purpose)
          form.append('file', fileField(local.bytes, local.name), local.name)
        }, exec.signal)
        const fileId = uploaded?.id
        if (typeof fileId !== 'string' || fileId.length === 0) throw new Error(`Files API 未返回 file_id：${JSON.stringify(uploaded).slice(0, 300)}`)

        const { json } = await postJSON(`${auth.baseURL}/chat/completions`, auth.headers, {
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'file', file_id: fileId },
              { type: 'text', text: args.question },
            ],
          }],
        }, exec.signal)
        const { text, finish, usage } = readCompletion(json)
        const refusal = finish === 'content_filter'
        return {
          answer: refusal ? '' : text,
          fileId,
          purpose,
          bytes: local.size,
          refusal,
          ...(refusal ? { usage } : {}),
        }
      },
    },

    readlink: {
      name: TOOL_NAMES.readlink,
      description: '抓取一个网页并以 Markdown 返回正文（DeepSeek Fetch API）。适合读用户给出的具体链接；'
        + '需要搜索时用 web_search。静态页面通常能读到正文，登录墙与反爬页面可能失败。',
      parameters: {
        url: { type: 'string', required: true, description: '要读的 HTTP/HTTPS 链接，需含主机名。' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            content: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.title ? `# ${value.title}\n\n` : ''}${value.content}${value.truncated ? '\n\n（正文已截断）' : ''}`,
        }],
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const current = config()
        const auth = await resolveAuth(ctx, current, current.readlink.provider)
        const { json } = await postJSON(`${auth.baseURL}/v1/tools/fetch`, auth.headers, { url: args.url }, exec.signal)
        const content = typeof json?.content === 'string' ? json.content : ''
        const cap = 200_000
        return {
          title: typeof json?.title === 'string' ? json.title : '',
          content: content.length > cap ? content.slice(0, cap) : content,
          truncated: content.length > cap,
        }
      },
    },

    safety: {
      name: TOOL_NAMES.safety,
      description: '用 DeepSeek 的基础风控审核一段文本是否可用（模型内容安全）。'
        + '对外发布内容、用户输入转述前可以用它自检；它不能替代你自己的内容安全审核义务。',
      parameters: {
        text: { type: 'string', required: true, description: '要审核的文本。' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            safe: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `${value.safe ? '通过' : '命中风险'}：${value.reason}` }],
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const current = config()
        const auth = await resolveAuth(ctx, current, current.safety.provider)
        const endpoint = `${auth.baseURL}/chat/completions`
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { ...auth.headers, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            model: current.safety.model || DEFAULT_MODEL,
            safety_check: { level: 'high' },
            max_tokens: 16,
            messages: [{ role: 'user', content: args.text }],
          }),
          signal: exec.signal,
        })
        if (!response.ok) {
          const detail = await errorDetail(response)
          // 输入命中审核时官方返回 400 Content Exists Risk。
          if (response.status === 400 && /content exists risk/iu.test(detail)) {
            return { safe: false, reason: '输入命中内容审核（Content Exists Risk）' }
          }
          throw new Error(detail)
        }
        return safetyVerdict(await response.json())
      },
    },

    ocr: {
      name: TOOL_NAMES.ocr,
      description: '识别 PDF、Word、PowerPoint 或图片里的文字（DeepSeek OCR API），按页返回。'
        + '文件不会存进 Files API，也不会交给对话模型；要让模型基于文档作答请用 ' + TOOL_NAMES.file + '。',
      parameters: {
        path: { type: 'string', required: true, description: '本地文件路径；相对路径按会话工作目录解析。' },
        layout: {
          type: 'boolean', default: false,
          description: 'true 时用 rich_layout_recognition（所有文件逐页识别，保留版面标记）；默认 text_recognition。',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            purpose: { type: 'string', required: true },
            pageCount: { type: 'integer', required: true },
            pages: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  index: { type: 'integer', required: true },
                  text: { type: 'string', required: true },
                  finishReason: { type: 'string', required: true },
                },
              },
            },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.pages
            .map((page) => `## 第 ${page.index + 1} 页${page.finishReason === 'length' ? '（输出被截断）' : ''}\n${page.text}`)
            .join('\n\n') + (value.truncated ? '\n\n（页数过多，已截断）' : ''),
        }],
      },
      timeoutMs: 200_000,
      async execute(args, exec) {
        const current = config()
        const auth = await resolveAuth(ctx, current, current.ocr.provider)
        const local = await readLocalFile(args.path, 'document', exec.signal, sessionCwd(exec))
        const purpose = args.layout === true ? 'rich_layout_recognition' : 'text_recognition'
        const json = await postForm(`${auth.baseURL}/v1/tools/ocr`, auth.headers, (form) => {
          form.append('purpose', purpose)
          form.append('file', fileField(local.bytes, local.name), local.name)
        }, exec.signal)
        if (json?.error !== undefined) {
          const detail = typeof json.error === 'string' ? json.error : json.error?.message
          throw new Error(`OCR 失败：${typeof detail === 'string' ? detail : JSON.stringify(json.error)}`)
        }
        const rawPages = Array.isArray(json?.pages) ? json.pages : []
        const cap = 200
        return {
          purpose: typeof json?.purpose === 'string' ? json.purpose : purpose,
          pageCount: Number.isSafeInteger(json?.page_count) ? json.page_count : rawPages.length,
          pages: rawPages.slice(0, cap).map((page, index) => ({
            index: Number.isSafeInteger(page?.index) ? page.index : index,
            text: typeof page?.text === 'string' ? page.text : '',
            finishReason: typeof page?.finish_reason === 'string' ? page.finish_reason : 'stop',
          })),
          truncated: rawPages.length > cap,
        }
      },
    },

    asr: {
      name: TOOL_NAMES.asr,
      description: '把音频转写成文字（DeepSeek ASR API）。只收 16 位 PCM WAV 或 Ogg Opus，单个文件最大 8 MiB、最长 120 秒；语种自动识别。',
      parameters: {
        path: { type: 'string', required: true, description: '本地音频路径；相对路径按会话工作目录解析。' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            durationMs: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.text}\n\n（音频 ${(value.durationMs / 1000).toFixed(1)} 秒）`,
        }],
      },
      timeoutMs: 660_000,
      async execute(args, exec) {
        const current = config()
        const auth = await resolveAuth(ctx, current, current.asr.provider)
        const local = await readLocalFile(args.path, 'audio', exec.signal, sessionCwd(exec))
        if (!AUDIO_EXTENSIONS.has(path.extname(local.name).toLowerCase())) {
          throw new Error(`${local.name} 不是 WAV/Ogg Opus；ASR 只收 16 位 PCM WAV 与 Ogg Opus`)
        }
        const json = await postForm(`${auth.baseURL}/v1/tools/asr`, auth.headers, (form) => {
          form.append('file', fileField(local.bytes, local.name), local.name)
        }, exec.signal)
        return {
          text: typeof json?.text === 'string' ? json.text : '',
          durationMs: Number.isFinite(json?.duration_ms) ? Math.round(json.duration_ms) : 0,
        }
      },
    },

    tts: {
      name: TOOL_NAMES.tts,
      description: '把文字合成为语音（DeepSeek TTS API），音频会保存成本地文件并作为交付物展示，可直接点开。'
        + '默认音色 stella（女声），另一种是 tide（男声）；文本最多 10,000 个计费字符。',
      parameters: {
        text: { type: 'string', required: true, description: '要朗读的文本，不能为空。' },
        voice: { type: 'string', enum: ['stella', 'tide'], description: '音色；省略用设置面板里的默认值。' },
        filterMarkdown: { type: 'boolean', default: true, description: '朗读前是否去掉 Markdown 标记。' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            voice: { type: 'string', required: true },
            format: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `语音已保存：${value.path}（${value.voice}，${value.format}，${value.bytes} 字节）`,
        }],
      },
      timeoutMs: 660_000,
      async execute(args, exec) {
        const current = config()
        const auth = await resolveAuth(ctx, current, current.tts.provider)
        const voice = typeof args.voice === 'string' ? args.voice : current.tts.voice
        const format = current.tts.format === 'pcm' ? 'pcm' : 'wav'
        const response = await fetch(`${auth.baseURL}/v1/tools/tts`, {
          method: 'POST',
          headers: { ...auth.headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            text: args.text,
            voice_id: voice,
            format,
            filter_markdown: args.filterMarkdown !== false,
          }),
          signal: exec.signal,
        })
        if (!response.ok) throw new Error(await errorDetail(response))
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0) throw new Error('TTS 未返回音频数据')
        const cwd = sessionCwd(exec)
        const target = await writeAudio(cwd, current.tts.outputDir, bytes, format, exec.signal)
        if (exec.agent !== undefined) {
          try {
            const boundary = ctx.get('agents')?.turnBoundaryOf?.(exec.agent.session)
            if (boundary !== undefined && boundary.openTurnStartSeq !== null) {
              pendingDeliveries.set(exec, {
                session: exec.agent.session,
                turn: boundary.lastTurn,
                callId: exec.callId,
                path: target,
              })
            }
          } catch { /* 交付出错不影响音频已经落盘 */ }
        }
        return { path: target, bytes: bytes.length, voice, format }
      },
    },
  }

  // 逐个注册：`when` 每次读活配置，开关立刻生效且不改注册表。
  for (const key of CAPABILITIES) {
    const definition = definitions[key]
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: schemaOf(definition.parameters),
      output: { schema: toJsonSchema(definition.output.schema), render: definition.output.render },
      timeoutMs: definition.timeoutMs,
      execute: definition.execute,
    }, { when: () => enabled(config(), key) })
  }

  // 工具结果落定后，把 TTS 音频写成交付物（对话里可点击打开）。
  ctx.on('tools/result', (exec, result) => {
    const delivery = pendingDeliveries.get(exec)
    pendingDeliveries.delete(exec)
    if (delivery === undefined || result.isError) return
    try {
      delivery.session.append('deliverables/presented', {
        turn: delivery.turn,
        callId: delivery.callId,
        files: [{ path: delivery.path, description: 'DeepSeek TTS 语音' }],
      })
    } catch { /* 交付事件失败不影响工具结果 */ }
  })

  // 设置面板的配置端点：只服务本机回环请求。
  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return () => {}
    return webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      async handler(req, res) {
        const peer = req.socket?.remoteAddress ?? ''
        const local = peer === '' || peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
        if (!local) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'only loopback requests may read this configuration' }))
          return
        }
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method === 'GET' || req.method === 'HEAD') {
            send(200, { config: readConfig(), path: configPath() })
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const raw = Buffer.concat(chunks).toString('utf8')
          const parsed = raw.length === 0 ? {} : JSON.parse(raw)
          const next = writeConfig(parsed?.config ?? parsed)
          send(200, { config: next, path: configPath() })
        } catch (error) {
          send(400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })
}
