# dsh-api-bucket

把 DeepSeek 的[全家桶应用 API](https://api-docs.deepseek.com/zh-cn/updates)注册成 DeepSeek Harness（DSH）里的模型工具，并在设置面板里逐项开关、逐项选择提供方。

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
- 设置页每改一次点「保存」即刻生效，无需重启（工具通过 `when` 读活配置）；
- 文件损坏会自动改名备份成 `*.broken-<时间戳>` 后重新生成。

字段：

```json
{
  "version": 1,
  "baseURL": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "file":     { "enabled": true, "provider": "auto", "model": "deepseek-flash" },
  "readlink": { "enabled": true, "provider": "auto" },
  "safety":   { "enabled": true, "provider": "auto", "model": "deepseek-flash" },
  "ocr":      { "enabled": true, "provider": "auto" },
  "asr":      { "enabled": true, "provider": "auto" },
  "tts":      { "enabled": true, "provider": "auto", "voice": "stella", "format": "wav", "outputDir": "dsh-api-bucket" }
}
```

`provider` 取值：

- `auto` —— 跟随当前会话的模型路由，口径与官方 `web-deepseek-api` 一致：
  会话跑在 `deepseek-account` 上时先用账号令牌、再用 API Key；跑在 `deepseek-official` 上时只用 API Key；其他路由先 API Key、再账号。
- `account` —— 只用已登录的 DeepSeek 账号（令牌走 `x-dsh-auth-token`）。
- `api-key` —— 只用 `apiKeyEnv` 指向的凭据（走 `Authorization: Bearer`）。

### 账号令牌的可用范围（实测）

官方账号令牌只对部分端点有效。同一把令牌打同一批 `/v1/tools` 端点的实测结果：

| 端点 | 账号令牌 | API Key |
| --- | --- | --- |
| `/v1/tools/fetch`（阅读链接） | 200 | 200 |
| `/v1/tools/ocr`（OCR） | 200 | 200 |
| `/chat/completions`（文件输入、模型安全） | 200 | 200 |
| `/v1/tools/tts`（语音合成） | **401** | 200 |
| `/v1/tools/asr`（语音识别） | **401** | 200 |

TTS 与 ASR 拒绝账号令牌时返回 `401 Authentication Fails (missing key)`；把令牌换成 `Bearer` 或 `x-api-key` 头重试仍是 401，是该服务端的凭据边界，不是请求写法问题。

因此：**TTS 与 ASR 的提供方请用 `api-key` 或 `auto`**；选 `account` 时插件会直接告诉你改成哪种，而不是抛一个裸 401。

## 各工具的行为

- **`deepseek_file_input(path, question, mode)`**：按扩展名选 purpose —— PDF/Word/PPT 走 `text_recognition`（`mode: layout` 时用 `rich_layout_recognition`），图片与纯文本走 `user_data`；上传拿 `file_id` 后在对话里引用并回答 `question`。返回 `answer`、`fileId`、`purpose`、`bytes`；命中内容审核时 `refusal: true`。
- **`deepseek_read_link(url)`**：返回网页 `title` 与 Markdown 正文，超过 200,000 字符截断。
- **`deepseek_safety_check(text)`**：以 `safety_check: { level: "high" }` 送审，返回 `safe` 与原因；输入命中审核（HTTP 400 `Content Exists Risk`）也算 `safe: false`。
- **`deepseek_ocr(path, layout)`**：按页返回 `pages[].text` 与 `finish_reason`，最多 200 页。
- **`deepseek_asr(path)`**：只收 16 位 PCM WAV / Ogg Opus，最大 8 MiB。
- **`deepseek_tts(text, voice?, filterMarkdown?)`**：音频 Bytes 由插件写入会话工作目录下的 `outputDir`，并作为 `deliverables/presented` 交付物登记 —— 对话里能像其他交付文件一样点开。

## 权限与安全

- `/__dsh_api_bucket__/config` 只接受本机回环请求，其他来源 403。
- API Key 只从 DSH 的凭据服务（或启动环境变量）读，不写进配置、不写进日志。
- 插件不缓存储存凭据，每次调用重新解析。

## 依赖

零第三方依赖：只用 Node 内置模块与全局 `fetch`/`FormData`/`Blob`。

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
