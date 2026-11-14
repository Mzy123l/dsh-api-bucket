/**
 * 凭据 × 端点 对照实验（不随插件发布）。
 * 同一个账号令牌、同一把 API Key，分别打四个 /v1/tools 端点，
 * 列出各自的状态码，用来判断 401 是凭据边界还是请求写法问题。
 *
 * 用法：node dev/probe-endpoints.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://api.deepseek.com'

/** 读账号令牌（不打印）。 */
function readToken() {
  const file = path.join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  let inside = false
  let token
  for (const line of lines) {
    if (/^\s{2}deepseek-account-platform\/default:\s*$/.test(line)) { inside = true; continue }
    if (inside && /^\s{2}\S.*:\s*$/.test(line)) break
    if (!inside) continue
    const m = /^\s+token:\s*(\S+)\s*$/.exec(line)
    if (m) token = m[1]
  }
  return token
}

/** 读 API Key（不打印）。 */
function readKey() {
  const file = path.join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')
  const m = /^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/mu.exec(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  return m?.[1]
}

const token = readToken()
const key = readKey()
console.log('账号令牌:', token === undefined ? '缺失' : `存在（${token.length} 字符）`)
console.log('API Key :', key === undefined ? '缺失' : `存在（${key.length} 字符）`)

/** 提交一次探测，只回报状态码与错误摘要。 */
async function probe(label, headersFor, endpoint, init) {
  const headers = headersFor()
  let response
  try {
    response = await fetch(`${BASE}${endpoint}`, { ...init, headers: { ...headers, ...init.headers } })
  } catch (error) {
    console.log(`  ${label.padEnd(22)} ${endpoint.padEnd(20)} 网络错误 ${error.message}`)
    return
  }
  let detail = ''
  if (!response.ok) {
    try {
      const text = await response.text()
      detail = text.replace(/\s+/gu, ' ').slice(0, 90)
    } catch { /* 忽略 */ }
  } else {
    // 成功时别把音频/正文读进来，直接丢弃
    try { await response.arrayBuffer() } catch { /* 忽略 */ }
  }
  console.log(`  ${label.padEnd(22)} ${endpoint.padEnd(20)} HTTP ${response.status} ${detail}`)
}

const account = () => ({ 'x-dsh-auth-token': token })
const apiKey = () => ({ authorization: `Bearer ${key}` })

const json = { method: 'POST', headers: { 'content-type': 'application/json' } }
const ttsBody = { ...json, body: JSON.stringify({ text: '测试' }) }
const fetchBody = { ...json, body: JSON.stringify({ url: 'https://example.com/' }) }
const chatBody = { ...json, body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 }) }

const form = () => {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(path.join('dev', 'fixtures', 'ocr-sample.png'))], { type: 'application/octet-stream' }), 'ocr-sample.png')
  return fd
}

console.log('\n=== 账号令牌（x-dsh-auth-token）===')
await probe('account', account, '/v1/tools/fetch', fetchBody)
await probe('account', account, '/v1/tools/tts', ttsBody)
await probe('account', account, '/chat/completions', chatBody)
{
  const fd = form()
  fd.append('purpose', 'text_recognition')
  await probe('account', account, '/v1/tools/ocr', { method: 'POST', body: fd })
}
{
  // ASR 需要音频：用一小段静音 wav 即可探测鉴权
  const wav = readSilentWav()
  const fd = new FormData()
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav')
  await probe('account', account, '/v1/tools/asr', { method: 'POST', body: fd })
}

console.log('\n=== API Key（Bearer）===')
await probe('api-key', apiKey, '/v1/tools/fetch', fetchBody)
await probe('api-key', apiKey, '/v1/tools/tts', ttsBody)
await probe('api-key', apiKey, '/chat/completions', chatBody)
{
  const fd = form()
  fd.append('purpose', 'text_recognition')
  await probe('api-key', apiKey, '/v1/tools/ocr', { method: 'POST', body: fd })
}
{
  const wav = readSilentWav()
  const fd = new FormData()
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav')
  await probe('api-key', apiKey, '/v1/tools/asr', { method: 'POST', body: fd })
}

/** 造 1 秒 16kHz 单声道静音 WAV，仅用于探测鉴权。 */
function readSilentWav() {
  const sampleRate = 16000
  const samples = sampleRate
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}
