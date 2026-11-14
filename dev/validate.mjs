/**
 * 本地校验脚本（不随插件发布）：
 * 用一个假的 ctx 调 apply()，把注册到的每个工具定义拿真实的
 * DSH schema 校验器过一遍，并打印工具名与参数键，确认注册路径成立。
 *
 * 用法：node dev/validate.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const DSH = process.env.DSH_INSTALL_DIR
  ?? 'E:/Applications/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh'

// 用 DSH 自己的解析锚点加载，避免猜 lib 里的文件名。
const requireFromDsh = createRequire(path.join(DSH, 'package.json'))
const { assertSupportedJsonSchema } = requireFromDsh('@deepseek-ai/dsh-tools')

const registered = []
const effects = []
const handlers = []

const ctx = {
  tools: {
    register(definition, options = {}) {
      assertSupportedJsonSchema(definition.output.schema)
      assertSupportedJsonSchema(definition.parameters)
      registered.push({ definition, options })
      return () => {}
    },
  },
  effect(factory) {
    const disposer = factory()
    effects.push(disposer)
    return () => { if (typeof disposer === 'function') disposer() }
  },
  on(event, handler) {
    handlers.push({ event, handler })
    return () => {}
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          handlers.push({ event: 'webServer.register', handler: route })
          return () => {}
        },
      }
    }
    return undefined
  },
}

const mod = await import(pathToFileURL(path.resolve('index.js')).href)
mod.apply(ctx)

console.log(`注册工具 ${registered.length} 个：`)
for (const { definition, options } of registered) {
  const keys = Object.keys(definition.parameters.properties ?? {})
  const when = typeof options.when === 'function' ? 'when✓' : 'when✗'
  console.log(`  - ${definition.name}  params=[${keys.join(', ')}]  ${when}  timeout=${definition.timeoutMs}`)
  // render 至少要能产出一个 text 块，用示例值跑一次
  const sample = Object.fromEntries(keys.map((key) => [key, definition.parameters.properties[key].type === 'boolean' ? true : 'x']))
  try {
    const blocks = definition.output.render(sample, sample)
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('render 返回空')
  } catch (error) {
    console.log(`      render 失败（示例值不适用，跳过）：${error.message}`)
  }
}
console.log(`effect ${effects.length} 个，监听/路由 ${handlers.length} 个：${handlers.map(row => row.event).join(', ')}`)
console.log('校验通过')
