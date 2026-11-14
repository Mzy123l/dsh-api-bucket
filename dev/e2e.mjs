/**
 * 端到端实测脚本（不随插件发布）：
 * 走真实 ctx（真实凭据服务、真实账号服务）+ 真实 DeepSeek 网络往返，
 * 逐个跑通六个工具。
 *
 * 用法：node dev/e2e.mjs [case]
 *   case 缺省跑全部；也可以只跑 readlink / ocr / asr / tts / safety / file。
 *
 * 注意：会真实消耗额度（OCR 按页、ASR 按时长、TTS 按字符计费）。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const DSH = process.env.DSH_INSTALL_DIR
  ?? 'E:/Applications/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh'
const requireFromDsh = createRequire(path.join(DSH, 'package.json'))
requireFromDsh('@deepseek-ai/dsh-tools') // 确保锚点可用

const only = process.argv[2]
const registered = new Map()

// 真实凭据：直接从 DSH 的凭据服务口径读，绝不打印值。
const credentials = {
  async resolve(ref) {
    const file = path.join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')
    const text = fs.readFileSync(file, 'utf8')
    // 极简解析：定位 refs 下的 "NAME: value" 一行。
    const match = new RegExp(`^\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(\\S+)\\s*$`, 'mu').exec(text)
    return match === null ? undefined : { value: match[1], source: 'credentials-store' }
  },
  async describe(ref) {
    const hit = await this.resolve(ref)
    return { configured: hit !== undefined, writable: true }
  },
}

const ctx = {
  tools: {
    register(definition, options = {}) {
      registered.set(definition.name, { definition, options })
      return () => {}
    },
  },
  effect(factory) { const d = factory(); return () => { if (typeof d === 'function') d() } },
  on() { return () => {} },
  get(name) {
    if (name === 'credentials') return credentials
    return undefined
  },
}

const mod = await import(pathToFileURL(path.resolve('index.js')).href)
mod.apply(ctx)

const cwd = path.resolve('dev/fixtures')
fs.mkdirSync(cwd, { recursive: true })

function exec() {
  const appended = []
  return {
    callId: 'e2e-call',
    signal: new AbortController().signal,
    agent: {
      session: {
        header: { cwd },
        append(type, data) { appended.push({ type, data }) },
      },
    },
    appended,
  }
}

const cases = {
  async readlink() {
    const { definition } = registered.get('deepseek_read_link')
    const value = await definition.execute({ url: 'https://example.com/' }, exec())
    return { title: value.title, chars: value.content.length, head: value.content.slice(0, 80) }
  },

  async safety() {
    const { definition } = registered.get('deepseek_safety_check')
    const benign = await definition.execute({ text: '今天天气不错，适合出门散步。' }, exec())
    return benign
  },

  async ocr() {
    const { definition } = registered.get('deepseek_ocr')
    const value = await definition.execute({ path: 'ocr-sample.png', layout: false }, exec())
    return { pageCount: value.pageCount, text: value.pages.map(p => p.text).join(' | ').slice(0, 160) }
  },

  async tts() {
    const { definition } = registered.get('deepseek_tts')
    const e = exec()
    const value = await definition.execute({ text: '你好，这是 dsh-api-bucket 的语音合成测试。', voice: 'stella' }, e)
    const info = fs.statSync(value.path)
    return { path: value.path, bytes: value.bytes, onDisk: info.size, appended: e.appended.map(a => a.type) }
  },

  async file() {
    // 用一张小图做文件输入（图片走 user_data，不需要解析计费）
    const { definition } = registered.get('deepseek_file_input')
    const value = await definition.execute({
      path: 'ocr-sample.png',
      question: '这张图片里写了什么？只回答文字内容。',
    }, exec())
    return { answer: value.answer.slice(0, 200), fileId: value.fileId, purpose: value.purpose, refusal: value.refusal }
  },
}

// ASR 需要一段真实音频：先用 TTS 生成，再转写，形成闭环。
cases.asr = async () => {
  const tts = registered.get('deepseek_tts').definition
  const made = await tts.execute({ text: '这是一段用于语音识别的测试音频。', voice: 'tide' }, exec())
  const { definition } = registered.get('deepseek_asr')
  const value = await definition.execute({ path: made.path }, exec())
  return { audio: path.basename(made.path), text: value.text, durationMs: value.durationMs }
}

const order = only === undefined ? ['readlink', 'safety', 'ocr', 'tts', 'asr', 'file'] : [only]
for (const key of order) {
  try {
    const result = await cases[key]()
    console.log(`✓ ${key}: ${JSON.stringify(result)}`)
  } catch (error) {
    console.log(`✗ ${key}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
