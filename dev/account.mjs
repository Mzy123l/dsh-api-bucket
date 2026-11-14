/**
 * 账号通路实测（不随插件发布）：
 * 模拟真实 DSH 的 deepseekAccount 服务——按官方规则只对 api.deepseek.com
 * 放行令牌——并强制 provider=account，验证六个工具能否用「已登录的 DeepSeek 账号」调用。
 *
 * 用法：node dev/account.mjs [case]
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH = process.env.DSH_INSTALL_DIR
  ?? 'E:/Applications/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh'
createRequire(path.join(DSH, 'package.json'))('@deepseek-ai/dsh-tools')

const only = process.argv[2]
const registered = new Map()

/** 从真实凭据库读账号 grant 记录（不打印令牌）。 */
function readGrant() {
  const file = path.join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  let inDefault = false
  let token
  let issuer
  for (const line of lines) {
    if (/^\s{2}deepseek-account-platform\/default:\s*$/.test(line)) { inDefault = true; continue }
    if (inDefault && /^\s{2}\S.*:\s*$/.test(line)) break
    if (!inDefault) continue
    const t = /^\s+token:\s*(\S+)\s*$/.exec(line)
    if (t) token = t[1]
    const i = /^\s+issuer:\s*(\S+)\s*$/.exec(line)
    if (i) issuer = i[1]
  }
  return { token, issuer }
}

const grant = readGrant()
if (grant.token === undefined) {
  console.error('凭据库里没有 deepseek-account-platform/default 的 token')
  process.exit(1)
}

/** 令牌来源统计：确认这次调用真的走了账号而不是 API Key。 */
const usedToken = []

const credentials = {
  async resolve() { return undefined },  // 故意让 API Key 不可用
  async describe() { return { configured: false, writable: true } },
}

const deepseekAccount = {
  /** 与官方 @deepseek-ai/dsh-deepseek-account 的 resolveToken 同口径。 */
  async resolveToken(url) {
    const destination = new URL(url)
    const inferenceOrigin = 'https://api.deepseek.com'
    if (destination.origin !== inferenceOrigin) return undefined
    if (grant.token.startsWith('dsh_mock_')) return undefined
    if (grant.issuer !== undefined) {
      const issuerUrl = new URL(grant.issuer)
      if (inferenceOrigin === 'https://api.deepseek.com' && ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname)) {
        return undefined
      }
    }
    usedToken.push(destination.href)
    return grant.token
  },
  async rejectToken() {},
}

const ctx = {
  tools: { register(d, o = {}) { registered.set(d.name, { definition: d, options: o }); return () => {} } },
  effect(factory) { const d = factory(); return () => { if (typeof d === 'function') d() } },
  on() { return () => {} },
  get(name) {
    if (name === 'credentials') return credentials
    if (name === 'deepseekAccount') return deepseekAccount
    return undefined
  },
}

// 用独立临时 DSH_HOME，把六个能力的 provider 都强制成 account。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-account-'))
process.env.DSH_HOME = home
const mod = await import(pathToFileURL(path.resolve('index.js')).href)
mod.apply(ctx)

const configFile = path.join(home, 'dsh-api-bucket-profile.json')
// apply() 的配置是惰性读的，先读一次让它按出厂值建文件。
mod.readConfig()
const seeded = JSON.parse(fs.readFileSync(configFile, 'utf8'))
for (const key of ['file', 'readlink', 'safety', 'ocr', 'asr', 'tts']) {
  seeded[key].provider = 'account'
  seeded[key].enabled = true
}
fs.writeFileSync(configFile, JSON.stringify(seeded, null, 2), 'utf8')

const cwd = path.resolve('dev/fixtures')
fs.mkdirSync(cwd, { recursive: true })

function exec() {
  const appended = []
  return {
    callId: 'acct-call',
    signal: new AbortController().signal,
    agent: { session: { header: { cwd }, append(type, data) { appended.push({ type, data }) } } },
    appended,
  }
}

const cases = {
  async readlink() {
    const v = await registered.get('deepseek_read_link').definition.execute({ url: 'https://example.com/' }, exec())
    return { title: v.title, chars: v.content.length }
  },
  async safety() {
    const v = await registered.get('deepseek_safety_check').definition.execute({ text: '今天天气不错。' }, exec())
    return v
  },
  async ocr() {
    const v = await registered.get('deepseek_ocr').definition.execute({ path: 'ocr-sample.png' }, exec())
    return { pageCount: v.pageCount, text: v.pages.map(p => p.text).join(' ').slice(0, 100) }
  },
  async tts() {
    const v = await registered.get('deepseek_tts').definition.execute({ text: '账号通路的语音测试。' }, exec())
    return { bytes: v.bytes, name: path.basename(v.path) }
  },
  async asr() {
    const made = await registered.get('deepseek_tts').definition.execute({ text: '账号通路识别测试。' }, exec())
    const v = await registered.get('deepseek_asr').definition.execute({ path: made.path }, exec())
    return { text: v.text, durationMs: v.durationMs }
  },
  async file() {
    const v = await registered.get('deepseek_file_input').definition.execute({
      path: 'ocr-sample.png', question: '图片里的文字是什么？只回答文字。',
    }, exec())
    return { answer: v.answer.slice(0, 120), purpose: v.purpose, fileId: v.fileId.slice(0, 24) }
  },
}

const order = only === undefined ? ['readlink', 'safety', 'ocr', 'tts', 'asr', 'file'] : [only]
for (const key of order) {
  usedToken.length = 0
  try {
    const result = await cases[key]()
    console.log(`✓ ${key}: ${JSON.stringify(result)}  [账号令牌请求 ${usedToken.length} 次]`)
  } catch (error) {
    console.log(`✗ ${key}: ${error?.message ?? error}  [账号令牌请求 ${usedToken.length} 次]`)
    process.exitCode = 1
  }
}

fs.rmSync(home, { recursive: true, force: true })
