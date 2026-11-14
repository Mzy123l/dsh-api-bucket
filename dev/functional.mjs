/**
 * 本地功能校验（不随插件发布）：
 *  1. 配置文件的读取/规范化/写回（含损坏文件、缺字段、非法值）；
 *  2. `/__dsh_api_bucket__/config` 路由的 GET / POST / 非回环拒绝；
 *  3. TTS 落盘与交付物事件的接线。
 *
 * 用法：node dev/functional.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH = process.env.DSH_INSTALL_DIR
  ?? 'E:/Applications/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh'
const requireFromDsh = createRequire(path.join(DSH, 'package.json'))
const { assertSupportedJsonSchema } = requireFromDsh('@deepseek-ai/dsh-tools')

// 用临时 DSH_HOME，绝不碰真实配置。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-bucket-test-'))
process.env.DSH_HOME = home

const mod = await import(pathToFileURL(path.resolve('index.js')).href)

const configFile = path.join(home, 'dsh-api-bucket-profile.json')

// ---------- 1. 首次读取会建文件 ----------
const seeded = mod.readConfig()
assert.equal(fs.existsSync(configFile), true, '首次 readConfig 应建出配置文件')
assert.equal(seeded.baseURL, 'https://api.deepseek.com')
assert.equal(seeded.file.enabled, true)
assert.equal(seeded.tts.voice, 'stella')
console.log('✓ 首次读取建文件，出厂值正确')

// ---------- 2. 非法值回落默认 ----------
const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'))
stored.file = { enabled: false, provider: '不存在的提供方' }
stored.tts = { enabled: 'yes', provider: 'account', voice: 'nobody', outputDir: '' }
stored.baseURL = 'https://example.com///'
fs.writeFileSync(configFile, JSON.stringify(stored), 'utf8')
const normalized = mod.readConfig()
assert.equal(normalized.file.enabled, false, 'enabled=false 应保留')
assert.equal(normalized.file.provider, 'auto', '非法 provider 应回落 auto')
assert.equal(normalized.tts.enabled, true, '非布尔 enabled 应回落默认 true')
assert.equal(normalized.tts.voice, 'stella', '非法 voice 应回落 stella')
assert.equal(normalized.tts.outputDir, 'dsh-api-bucket', '空 outputDir 应回落默认')
assert.equal(normalized.baseURL, 'https://example.com', '基址尾部斜杠应剥掉')
console.log('✓ 非法值与缺字段按默认收敛')

// ---------- 3. 损坏文件会备份重建 ----------
fs.writeFileSync(configFile, '{ 这不是 JSON', 'utf8')
const recovered = mod.readConfig()
assert.equal(recovered.file.enabled, true)
const backups = fs.readdirSync(home).filter((name) => name.includes('.broken-'))
assert.equal(backups.length, 1, '损坏文件应被改名备份一次')
console.log('✓ 损坏文件备份后重建')

// ---------- 4. 写回并原子落盘 ----------
const written = mod.writeConfig({ ...recovered, asr: { enabled: false, provider: 'api-key' } })
assert.equal(written.asr.enabled, false)
const reread = JSON.parse(fs.readFileSync(configFile, 'utf8'))
assert.equal(reread.asr.provider, 'api-key')
assert.equal(fs.readdirSync(home).some((name) => name.includes('.tmp-')), false, '不应残留临时文件')
console.log('✓ 写回原子落盘，无临时文件残留')

// ---------- 5. 路由：GET / POST / 403 ----------
const routes = new Map()
const registered = []
const resultHandlers = []
const ctx = {
  tools: {
    register(definition, options = {}) {
      assertSupportedJsonSchema(definition.parameters)
      assertSupportedJsonSchema(definition.output.schema)
      registered.push({ definition, options })
      return () => {}
    },
  },
  effect(factory) { const disposer = factory(); return () => { if (typeof disposer === 'function') disposer() } },
  on(event, handler) { if (event === 'tools/result') resultHandlers.push(handler); return () => {} },
  get(name) {
    if (name !== 'webServer') return undefined
    return {
      register(route) { routes.set(`${route.kind}:${route.path}`, route); return () => {} },
    }
  },
}
mod.apply(ctx)

assert.equal(registered.length, 6, '应注册 6 个工具')
const route = routes.get('exact:/__dsh_api_bucket__/config')
assert.ok(route !== undefined, '应注册配置端点')

/** 造一个最小的 req/res，跑一次路由。 */
function call({ method = 'GET', body, address = '127.0.0.1', url = '/__dsh_api_bucket__/config' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  const headers = {}
  let payload = ''
  const res = {
    writeHead(code, extra) { status = code; Object.assign(headers, extra ?? {}) },
    end(text) { payload = text ?? '' },
  }
  return route.handler(req, res).then(() => ({ status, headers, body: payload.length === 0 ? null : JSON.parse(payload) }))
}

const get = await call()
assert.equal(get.status, 200)
assert.equal(get.body.config.asr.enabled, false, 'GET 应返回当前配置')
assert.equal(get.body.path, configFile)
console.log('✓ GET 返回当前配置与路径')

const post = await call({ method: 'POST', body: { config: { ...get.body.config, ocr: { enabled: true, provider: 'api-key' } } } })
assert.equal(post.status, 200)
assert.equal(post.body.config.ocr.provider, 'api-key', 'POST 应写回并回显')
assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).ocr.provider, 'api-key', 'POST 应真的落盘')
console.log('✓ POST 写回并落盘')

const remote = await call({ address: '10.0.0.9' })
assert.equal(remote.status, 403, '非回环请求应 403')
console.log('✓ 非回环请求被拒')

const bad = await call({ method: 'POST', body: { config: 12 } })
assert.equal(bad.status, 200, '非法配置体应被收敛而非 500')
assert.equal(bad.body.config.ocr.enabled, true, '非法体回落默认值')
console.log('✓ 非法请求体收敛为默认配置')

// ---------- 6. 工具 when 读活配置 ----------
// 上一步的非法体已把配置收敛回默认值，这里显式设一次再断言。
mod.writeConfig({ ...mod.readConfig(), asr: { enabled: false, provider: 'auto' }, ocr: { enabled: true, provider: 'auto' } })
const byName = new Map(registered.map((row) => [row.definition.name, row]))
const asr = byName.get('deepseek_asr')
assert.equal(asr.options.when(), false, 'asr 已关闭时 when 应为 false')
const ocr = byName.get('deepseek_ocr')
assert.equal(ocr.options.when(), true, 'ocr 已开启时 when 应为 true')
// 改配置后立即生效（不重启）
mod.writeConfig({ ...mod.readConfig(), asr: { enabled: true, provider: 'auto' } })
assert.equal(asr.options.when(), true, '重新打开后 when 应立刻为 true')
console.log('✓ when 读活配置，开关立即生效')

// ---------- 7. TTS 无凭据时给出可读错误 ----------
const tts = byName.get('deepseek_tts').definition
const fakeExec = {
  callId: 'call-1',
  signal: { throwIfAborted() {} },
  agent: {
    session: {
      header: { cwd: path.join(home, 'session-cwd') },
      append(type, data) { appended.push({ type, data }) },
    },
  },
}
const appended = []
fs.mkdirSync(fakeExec.agent.session.header.cwd, { recursive: true })
delete process.env.DEEPSEEK_API_KEY
mod.writeConfig({ ...mod.readConfig(), tts: { enabled: true, provider: 'api-key' } })
await assert.rejects(
  () => tts.execute({ text: '你好' }, fakeExec),
  (error) => {
    assert.match(String(error.message), /没有可用的 DeepSeek 凭据/u)
    return true
  },
  'TTS 无凭据时应报出可读错误',
)
console.log('✓ TTS 无凭据时报出可读错误')

fs.rmSync(home, { recursive: true, force: true })
console.log('全部功能校验通过')
