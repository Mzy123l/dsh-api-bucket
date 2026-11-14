/**
 * dsh-api-bucket 的设置页（设置 →「API 全家桶」）。
 *
 * 一页管六项能力：文件输入、阅读链接、模型安全、OCR、ASR、TTS。
 * 每项只有一行开关；六项统一由 DeepSeek API Key 驱动，
 * 不再逐个选提供方。TTS 另有音色与输出目录，页面底部是基址与 API Key 凭据名。
 *
 * 配置只存在本用户的 `$DSH_HOME/dsh-api-bucket-profile.json`：
 * 本页通过 `/__dsh_api_bucket__/config` 读写，不碰 profile 的 cordis.patch.yml。
 */

window.__ModuleLoader__.load({
  id: 'dsh-api-bucket',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const ENDPOINT = '/__dsh_api_bucket__/config'

    /**
     * 文案字典：键是中文原文（也是 t() 的 msgid），值是对应的英文。
     * 只有在 en 下才查表，中文直接用原文。
     */
    const DICT = {
      'API 全家桶': 'API suite',
      '把 DeepSeek 的全家桶应用 API 注册成模型工具': 'Register the DeepSeek suite APIs as model tools',
      '文件输入': 'File input',
      '阅读链接': 'Read link',
      '模型安全': 'Model safety',
      '语音识别': 'Speech recognition',
      '语音合成': 'Speech synthesis',
      '上传 PDF、Word、PowerPoint、图片或纯文本，让模型基于文件回答。': 'Upload a PDF, Word, PowerPoint, image or plain-text file and let the model answer from it.',
      '抓取一个网页并返回 Markdown 正文。': 'Fetch one web page and return its Markdown body.',
      '用基础风控审核一段文本是否可用。': 'Screen a piece of text with the basic risk control.',
      '识别文档或图片里的文字，按页返回。': 'Recognize text in a document or image, page by page.',
      '把音频转写成文字（16 位 PCM WAV 或 Ogg Opus，最长 120 秒）。': 'Transcribe audio to text (16-bit PCM WAV or Ogg Opus, up to 120 seconds).',
      '把文字合成为语音，音频存成本地文件并在对话里作为交付物展示。': 'Synthesize speech from text and save it as a local file shown as a deliverable in the conversation.',
      '模型': 'Model',
      '音色': 'Voice',
      '女声': 'Female',
      '男声': 'Male',
      '输出目录': 'Output folder',
      '相对当前会话的工作目录。': 'Relative to the current conversation\'s working directory.',
      '基址': 'Base URL',
      'API Key 凭据名': 'API key credential',
      '模型工具从该凭据读取 API Key；留空时用 DEEPSEEK_API_KEY。': 'The tools read the API key from this credential; blank means DEEPSEEK_API_KEY.',
      '六个能力统一使用 DeepSeek API Key 驱动。': 'All six capabilities use the DeepSeek API key.',
      '保存': 'Save',
      '保存中…': 'Saving…',
      '保存失败': 'Save failed',
      '读取失败': 'Cannot read the configuration',
      '配置只存在': 'Configuration lives only at',
      '开关': 'Toggle',
    }

    /** 当前语言：优先 DSH 的 locale 服务，退到 <html lang>。 */
    let LANG = 'zh'
    const listeners = new Set()
    const notify = () => { for (const fn of listeners) { try { fn() } catch { /* 忽略 */ } } }
    const onLangChange = (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }
    const normLang = (value) => String(value || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const detectLang = () => {
      try { return normLang(document?.documentElement?.lang) } catch { return 'zh' }
    }
    const setLang = (next) => {
      if (next === LANG) return
      LANG = next
      notify()
    }
    const t = (text) => (LANG === 'en' ? DICT[text] ?? text : text)

    /**
     * 接上 locale 服务；语言变化时无需刷新页面。
     * @returns 卸载函数。
     */
    function bindLocale(ctx) {
      let off = null
      const applyActive = (active) => setLang(active ? normLang(active) : detectLang())
      try {
        const locale = typeof ctx?.get === 'function' ? ctx.get('locale') : null
        if (locale && typeof locale.subscribe === 'function') {
          const read = () => {
            try {
              const snap = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
              if (snap && typeof snap.active === 'string') return snap.active
            } catch { /* 退回 html lang */ }
            return null
          }
          off = locale.subscribe(() => applyActive(read()))
        }
      } catch { /* 没有 locale 服务 */ }
      if (typeof off !== 'function') {
        try {
          off = ctx.on('locale/change', (snapshot) => {
            applyActive(typeof snapshot === 'string' ? snapshot : snapshot?.active)
          })
        } catch { /* 忽略 */ }
      }
      setLang(detectLang())
      let observer = null
      try {
        if (typeof MutationObserver === 'function' && document?.documentElement) {
          observer = new MutationObserver(() => setLang(detectLang()))
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        }
      } catch { /* 忽略 */ }
      return () => {
        try { if (typeof off === 'function') off() } catch { /* 忽略 */ }
        try { if (observer) observer.disconnect() } catch { /* 忽略 */ }
      }
    }

    /** 六项能力的行定义：键、标题、说明、是否带模型/音色。 */
    const ROWS = [
      { key: 'file', title: '文件输入', hint: '上传 PDF、Word、PowerPoint、图片或纯文本，让模型基于文件回答。' },
      { key: 'readlink', title: '阅读链接', hint: '抓取一个网页并返回 Markdown 正文。' },
      { key: 'safety', title: '模型安全', hint: '用基础风控审核一段文本是否可用。', model: true },
      { key: 'ocr', title: 'OCR', hint: '识别文档或图片里的文字，按页返回。' },
      { key: 'asr', title: '语音识别', hint: '把音频转写成文字（16 位 PCM WAV 或 Ogg Opus，最长 120 秒）。' },
      { key: 'tts', title: '语音合成', hint: '把文字合成为语音，音频存成本地文件并在对话里作为交付物展示。', tts: true },
    ]

    /* ---------- 样式（全部走主题令牌，跟随亮/暗色） ---------- */

    const S = {
      section: { display: 'flex', flexDirection: 'column', gap: 16 },
      title: { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      card: { display: 'flex', flexDirection: 'column', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)' },
      row: { display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px' },
      rowDivider: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      rowHead: { display: 'flex', alignItems: 'center', gap: 12 },
      rowText: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
      rowTitle: { fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 12, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      select: {
        height: 34, padding: '0 10px', borderRadius: 8, font: 'inherit', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
      },
      input: {
        height: 34, padding: '0 10px', borderRadius: 8, font: 'inherit', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
      },
      button: {
        height: 32, padding: '0 14px', borderRadius: 8, font: 'inherit', fontSize: 13, cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
      },
      status: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      error: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
    }

    /**
     * 开关：原生 button + role=switch，键盘可用，状态通过 aria-checked 暴露。
     */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: () => onChange(!checked),
        style: {
          position: 'relative', flex: 'none', width: 36, height: 20, padding: 0, borderRadius: 999,
          cursor: disabled ? 'default' : 'pointer', border: 'none',
          background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
          opacity: disabled ? 0.5 : 1, transition: 'background 120ms ease',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: '50%',
          background: 'var(--dsw-alias-bg-layer-1)', transition: 'left 120ms ease',
        },
      }))
    }

    /** 一行文字字段。 */
    function Field({ label, hint, value, onChange, placeholder, disabled }) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, label),
        h('input', {
          type: 'text', value: value ?? '', placeholder: placeholder ?? '', disabled,
          onChange: (event) => onChange(event.target.value), style: S.input,
        }),
        hint ? h('span', { style: S.hint }, hint) : null,
      )
    }

    /** 一行下拉菜单。 */
    function Select({ label, value, options, disabled, onChange }) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, label),
        h('select', {
          value, disabled, onChange: (event) => onChange(event.target.value), style: S.select,
        }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
      )
    }

    /**
     * 设置页主体。
     * 自动保存：任何字段改动立即写回 Host，无需点保存。
     * 自动更新：轮询配置指纹（rev），外部变化（手改文件、模型页改动）自动刷新页面。
     * 凭据与基址来自「设置 → 模型」的 DeepSeek API Key 路由，本页只读展示。
     */
    function Panel() {
      const [config, setConfig] = useState(null)
      const [source, setSource] = useState(null)
      const [savedPath, setSavedPath] = useState('')
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(0)
      const alive = useRef(true)
      const revRef = useRef(null)
      /** 本地正在编辑的写回计数，轮询时用来区分「自己的改动」和「外部变化」。 */
      const pendingRef = useRef(0)
      /** 防抖计时器：输入类字段停止输入 400ms 后才写回。 */
      const timersRef = useRef({})

      const applyBody = useCallback((body) => {
        setConfig(body.config)
        setSource(body.source ?? null)
        setSavedPath(body.path ?? '')
        revRef.current = body.rev ?? null
      }, [])

      const load = useCallback(async () => {
        try {
          const response = await window.fetch(ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          if (!alive.current) return
          applyBody(body)
          setError('')
        } catch (cause) {
          if (alive.current) setError(String(cause?.message ?? cause))
        }
      }, [applyBody])

      useEffect(() => {
        alive.current = true
        void load()
        return () => { alive.current = false }
      }, [load])

      // 自动更新：轮询 rev，外部变化时才重拉配置；自己的写回由响应直接更新。
      useEffect(() => {
        const timer = setInterval(async () => {
          if (!alive.current || pendingRef.current > 0) return
          try {
            const response = await window.fetch(`${ENDPOINT}?probe=1`, { cache: 'no-store', headers: { accept: 'application/json' } })
            const body = await response.json()
            if (!response.ok || !alive.current) return
            if (revRef.current !== null && body.rev !== revRef.current) applyBody(body)
          } catch { /* 轮询失败静默，下个周期再试 */ }
        }, 2000)
        return () => { clearInterval(timer) }
      }, [applyBody])

      /** 写回一份完整配置；失败时提示但不回滚（下轮轮询会以 Host 为准）。 */
      const save = useCallback(async (next) => {
        pendingRef.current += 1
        setSaving((n) => n + 1)
        try {
          const response = await window.fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ config: next }),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          if (alive.current) {
            applyBody(body)
            setError('')
          }
        } catch (cause) {
          if (alive.current) setError(`${t('保存失败')}：${String(cause?.message ?? cause)}`)
        } finally {
          pendingRef.current = Math.max(0, pendingRef.current - 1)
          if (alive.current) setSaving((n) => Math.max(0, n - 1))
        }
      }, [applyBody])

      /** 自动保存一个字段：立即改本地 + 防抖写回（开关立即，输入防抖 400ms）。 */
      const autoSave = useCallback((key, patch, delay = 0) => {
        setConfig((current) => {
          if (current === null) return current
          const next = { ...current, [key]: { ...current[key], ...patch } }
          clearTimeout(timersRef.current[key])
          timersRef.current[key] = setTimeout(() => { void save(next) }, delay)
          return next
        })
      }, [save])

      /** 切换开关：立即写回，不防抖。 */
      const toggle = useCallback((key, next) => autoSave(key, { enabled: next }, 0), [autoSave])
      /** 文本/选择字段：防抖写回。 */
      const editField = useCallback((key, patch) => autoSave(key, patch, 400), [autoSave])

      if (config === null) {
        return h('div', { style: S.section },
          h('h4', { style: S.title }, t('API 全家桶')),
          error.length > 0
            ? h('p', { style: S.error }, `${t('读取失败')}：${error}`)
            : h('p', { style: S.hint }, '…'),
        )
      }

      return h('div', { style: S.section },
        h('div', null,
          h('h4', { style: S.title }, t('API 全家桶')),
          h('p', { style: S.hint }, t('把 DeepSeek 的全家桶应用 API 注册成模型工具')),
          h('p', { style: S.hint }, t('改动自动保存；凭据与基址来自「设置 → 模型」的 DeepSeek API Key。')),
        ),
        h('div', { style: S.card },
          ROWS.map((row, index) => {
            const state = config[row.key] ?? {}
            return h('div', { key: row.key, style: index === 0 ? S.row : { ...S.row, ...S.rowDivider } },
              h('div', { style: S.rowHead },
                h('div', { style: S.rowText },
                  h('span', { style: S.rowTitle }, t(row.title)),
                  h('span', { style: S.hint }, t(row.hint)),
                ),
                h(Switch, {
                  checked: state.enabled !== false,
                  disabled: saving > 0,
                  label: `${t(row.title)} ${t('开关')}`,
                  onChange: (next) => toggle(row.key, next),
                }),
              ),
              row.model === true
                ? h(Field, {
                    label: t('模型'),
                    value: state.model ?? 'deepseek-flash',
                    disabled: saving > 0,
                    onChange: (next) => editField(row.key, { model: next }),
                  })
                : null,
              row.tts === true
                ? h(React.Fragment, null,
                    h(Select, {
                      label: t('音色'),
                      value: state.voice ?? 'stella',
                      options: [
                        { value: 'stella', label: `stella · ${t('女声')}` },
                        { value: 'tide', label: `tide · ${t('男声')}` },
                      ],
                      disabled: saving > 0,
                      onChange: (next) => editField(row.key, { voice: next }),
                    }),
                    h(Field, {
                      label: t('输出目录'),
                      hint: t('相对当前会话的工作目录。'),
                      value: state.outputDir ?? 'dsh-api-bucket',
                      disabled: saving > 0,
                      onChange: (next) => editField(row.key, { outputDir: next }),
                    }),
                  )
                : null,
            )
          }),
        ),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: S.field },
              h('span', { style: S.label }, t('凭据来源')),
              h('span', { style: S.hint },
                source?.route === true
                  ? t('「设置 → 模型」的 DeepSeek API Key 路由（凭据 DEEPSEEK_API_KEY）。')
                  : t('未找到 DeepSeek API Key 路由，回落到官方基址与 DEEPSEEK_API_KEY 凭据。'),
              ),
            ),
          ),
        ),
        saving > 0 && error.length === 0 ? h('p', { style: S.hint }, t('保存中…')) : null,
        error.length > 0 ? h('p', { style: S.error }, error) : null,
        savedPath.length > 0
          ? h('p', { style: S.hint }, `${t('配置只存在')}：${savedPath}`)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try { ctx.effect(() => bindLocale(ctx)) } catch { bindLocale(ctx) }

        ctx.slots.inject('settings.section', () => {
          let dispose = null
          const register = () => {
            try { if (typeof dispose === 'function') dispose() } catch { /* 忽略 */ }
            dispose = ctx.slots.register({
              name: 'settings.section', id: 'dsh-api-bucket', order: 70, label: t('API 全家桶'),
            }, Panel)
          }
          register()
          const off = onLangChange(() => { try { register() } catch { /* 忽略 */ } })
          return () => {
            try { off() } catch { /* 忽略 */ }
            try { if (typeof dispose === 'function') dispose() } catch { /* 忽略 */ }
          }
        })
      },
    }
  },
})
