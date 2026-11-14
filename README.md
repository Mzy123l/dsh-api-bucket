# dsh-api-bucket

把 DeepSeek 的[全家桶应用 API](https://api-docs.deepseek.com/zh-cn/updates)注册成 DeepSeek Harness（DSH）里的模型工具，并在设置面板里逐项开关。六个能力统一由 DeepSeek API Key 驱动。

| 能力 | 工具名 | 官方接口 |
| --- | --- | --- |
| 文件输入 | `deepseek_file_input` | `POST /files` + `POST /chat/completions`（`file` 内容块） |
| 阅读链接 | `deepseek_read_link` | `POST /v1/tools/fetch` |
| 模型安全 | `deepseek_safety_check` | `POST /chat/completions` 的 `safety_check` |
| OCR | `deepseek_ocr` | `POST /v1/tools/ocr` |
| 语音识别 | `deepseek_asr` | `POST /v1/tools/asr` |
| 语音合成 | `deepseek_tts` | `POST /v1/tools/tts` |

## 安装

这是一个 DSH bundle。在 **设置 → 插件 → 添加插件** 里选择本目录，或由 DSH 的 `plugin_manager` 以本目录安装。安装后插件页出现「API 全家桶」一行，设置页左侧导航出现同名的「API 全家桶」页。

## 配置

配置**只**存在当前用户自己的 `$DSH_HOME/dsh-api-bucket-profile.json`（Windows 上默认 `C:\Users\<你>\.dsh\dsh-api-bucket-profile.json`）。插件不读也不写 profile 的 `cordis.patch.yml`，多用户共用一份 profile 时各用各的。

- 首次启动按出厂值自动建文件；
- 设置页**自动保存**：改动立即写回（开关即时，输入字段防抖 400ms），无需点任何按钮；
- 设置页**自动更新**：页面每 2 秒探测一次配置指纹，外部改动（手改文件）自动刷新，无需手动重读；
- 工具通过 `when` 读活配置，开关即刻生效，无需重启；
- 文件损坏会自动改名备份成 `*.broken-<时间戳>` 后重新生成。

字段：

```json
{
  "version": 3,
  "file":     { "enabled": true, "model": "deepseek-flash" },
  "readlink": { "enabled": true },
  "safety":   { "enabled": true, "model": "deepseek-flash" },
  "ocr":      { "enabled": true },
  "asr":      { "enabled": true },
  "tts":      { "enabled": true, "voice": "stella", "format": "wav", "outputDir": "dsh-api-bucket" }
}
```

### 凭据：直接读「设置 → 模型」的 DeepSeek API Key

插件里没有基址和凭据名配置。六个能力一律用「设置 → 模型」里 **DeepSeek API Key 路由**（`@deepseek-ai/dsh-llm-deepseek-api-key`）的 `baseURL` 与 `apiKeyEnv`——查找逻辑照抄官方 `web-deepseek-api` 的 `routeConfig`/`officialSource`；Key 经 DSH 凭据服务解析，请求头是 `Authorization: Bearer`。

- 模型页改了 Key 或基址，工具下一次调用立即跟随，无需改本插件；
- 该路由不存在或未启用时回落到官方基址 + `DEEPSEEK_API_KEY`，与官方行为一致；
- 设置页底部显示当前凭据来源（找到了路由，或已回落）。

这么做的原因是实测出来的服务端边界：官方账号令牌对部分端点无效。

| 端点 | 账号令牌 | API Key |
| --- | --- | --- |
| `/v1/tools/fetch`（阅读链接） | 200 | 200 |
| `/v1/tools/ocr`（OCR） | 200 | 200 |
| `/chat/completions`（文件输入、模型安全） | 200 | 200 |
| `/v1/tools/tts`（语音合成） | **401** | 200 |
| `/v1/tools/asr`（语音识别） | **401** | 200 |

TTS 与 ASR 拒绝账号令牌时返回 `401 Authentication Fails (missing key)`；把令牌换成 `Bearer` 或 `x-api-key` 头重试仍是 401，是服务端的凭据边界，不是请求写法问题。统一走 API Key 后六个能力才都能用。

> 从旧版升级：配置里的 `provider`、`baseURL`、`apiKeyEnv` 字段会被自动丢弃，不需要手动改；其它字段照常保留。

## 各工具的行为

- **`deepseek_file_input(path, question, mode)`**：按扩展名选 purpose —— PDF/Word/PPT 走 `text_recognition`（`mode: layout` 时用 `rich_layout_recognition`），图片与纯文本走 `user_data`；上传拿 `file_id` 后在对话里引用并回答 `question`。返回 `answer`、`fileId`、`purpose`、`bytes`；命中内容审核时 `refusal: true`。
- **`deepseek_read_link(url)`**：返回网页 `title` 与 Markdown 正文，超过 200,000 字符截断。
- **`deepseek_safety_check(text)`**：以 `safety_check: { level: "high" }` 送审，返回 `safe` 与原因；输入命中审核（HTTP 400 `Content Exists Risk`）也算 `safe: false`。
- **`deepseek_ocr(path, layout)`**：按页返回 `pages[].text` 与 `finish_reason`，最多 200 页。
- **`deepseek_asr(path)`**：只收 16 位 PCM WAV / Ogg Opus，最大 8 MiB。
- **`deepseek_tts(text, voice?, filterMarkdown?)`**：音频 Bytes 由插件写入会话工作目录下的 `outputDir`，并作为 `deliverables/presented` 交付物登记 —— 对话里能像其他交付文件一样点开。

## 权限与安全

- `/__dsh_api_bucket__/config` 只接受本机回环请求，其他来源 403。
- API Key 来自「设置 → 模型」的路由配置，经 DSH 凭据服务解析，不写进配置、不写进日志。
- 插件不缓存储存凭据，每次调用重新解析。

## 依赖

零第三方依赖：只用 Node 内置模块与全局 `fetch`/`FormData`/`Blob`。

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
