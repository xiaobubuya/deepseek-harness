import { Router, Request, Response } from 'express'
import { PHOTOCRAFT_COMMANDS, PHOTOCRAFT_SYSTEM_PROMPT, type ParamSpec } from '../core/photocraft-prompts.js'
import { getEngineCommandIds } from '../core/engine-commands.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import { callHarnessAgent } from '../core/harness-agent.js'
import OpenAI from 'openai'

const parse = Router()

const openai = new OpenAI({
  baseURL: config.llmApiUrl,
  apiKey: config.llmApiKey,
})

/** 一条要交给前端的 PhotoCraft 命令。 */
interface NativeCommand {
  id: string
  params: Record<string, unknown>
}

/**
 * 按目录里的约束收敛一个参数值：类型不对、超范围、未知键一律丢弃。
 * 返回 undefined 表示这个键不要了。
 */
function sanitizeParam(spec: ParamSpec, value: unknown): unknown {
  if (spec.bool) {
    return typeof value === 'boolean' ? value : undefined
  }
  if (spec.arrayOf !== undefined) {
    if (!Array.isArray(value) || value.length !== spec.arrayOf) return undefined
    const nums = value.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-255, Math.min(255, v)) : Number.NaN))
    return nums.some((n) => Number.isNaN(n)) ? undefined : nums
  }
  if (spec.min !== undefined || spec.max !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    let v = value
    if (spec.min !== undefined) v = Math.max(spec.min, v)
    if (spec.max !== undefined) v = Math.min(spec.max, v)
    return spec.integer ? Math.round(v) : v
  }
  // 无约束的键（颜色、渐变停点、曲线点、预设 id）原样透传：
  // 这些结构由引擎自己校验，猜错反而更糟。
  return value
}

/** 目录外/参数无效的命令剔除结果。 */
interface SanitizeResult {
  valid: NativeCommand[]
  rejected: string[]
}

/**
 * 按 PHOTOCRAFT_COMMANDS 目录过滤并收敛模型（harness 或单次 LLM）产出的原生命令。
 * 目录里没有的 id、参数全丢光的命令一律剔除并记录，绝不静默放过。
 */
async function sanitizeCommands(parsedCommands: unknown): Promise<SanitizeResult> {
  const valid: NativeCommand[] = []
  const rejected: string[] = []

  if (!Array.isArray(parsedCommands)) {
    return { valid, rejected }
  }

  const engineIds = await getEngineCommandIds()

  for (const raw of parsedCommands) {
    if (!raw || typeof raw !== 'object') continue
    const cmd = raw as { id?: unknown; params?: unknown }
    const id = typeof cmd.id === 'string' ? cmd.id : ''
    const spec = PHOTOCRAFT_COMMANDS[id]
    // 命令是否真实存在：优先用引擎全量命令集（920 个）校验，
    // 引擎不可用时退化为只认内置的 image.adjustments.* 清单。
    const known = engineIds ? engineIds.has(id) : !!spec

    if (!known) {
      rejected.push(id || '(空 id)')
      continue
    }

    if (!spec) {
      // 新增类命令（变换/滤镜/图层等）：参数原样透传，由引擎自身校验。
      valid.push({ id, params: (cmd.params && typeof cmd.params === 'object' ? cmd.params : {}) as Record<string, unknown> })
      continue
    }

    const params: Record<string, unknown> = {}
    if (cmd.params && typeof cmd.params === 'object') {
      for (const [key, value] of Object.entries(cmd.params as Record<string, unknown>)) {
        const paramSpec = spec[key]
        if (!paramSpec) continue
        const clean = sanitizeParam(paramSpec, value)
        if (clean !== undefined) params[key] = clean
      }
    }

    // 不因「参数为空」丢弃：引擎命令的参数基本都有默认值
    // （如 blackWhite 的 reds/yellows...、brightnessContrast 的 brightness=0），
    // 省略参数是合法的；真缺必填项时由引擎执行阶段报错，不该在这里静默丢弃。
    valid.push({ id, params })
  }

  return { valid, rejected }
}

/** 将模型产出的原始文本提取为 {commands, explanation}（找不到 JSON 时给空命令）。 */
function extractParsed(content: string): { commands?: unknown; explanation?: string } {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return {}
  try {
    return JSON.parse(jsonMatch[0]) as { commands?: unknown; explanation?: string }
  } catch {
    return {}
  }
}

/** 指令解析走哪种引擎：harness agent 优先，LLM 兜底。 */
function envSource(): 'harness' | 'llm' {
  return config.harnessEnabled ? 'harness' : 'llm'
}

/**
 * POST /api/parse — 把自然语言指令解析成 PhotoCraft 原生命令。
 *
 * 返回 `{commands:[{id:"image.adjustments.<kind>", params:{...}}], explanation, tool}`。
 * 前端直接 `window.execute_command(id, JSON.stringify(params))`，不再做二次映射。
 */
parse.post('/', async (req: Request, res: Response) => {
  const { message, tool } = req.body
  const cliTool = tool === 'lightcraft' ? 'lightcraft' : 'photocraft'

  if (!message) {
    res.status(400).json({ error: '缺少 message 字段' })
    return
  }

  const source = envSource()

  try {
    logger.info(`[Parse] (${cliTool}, ${source}) ${String(message).slice(0, 80)}`)

    // 1. 优先走 harness agent（可多步规划，一句话多次修改一次生成一组命令）
    let parsed: { commands?: unknown; explanation?: string } | undefined
    if (source === 'harness') {
      try {
        const r = await callHarnessAgent(String(message))
        parsed = { commands: r.commands, explanation: r.explanation }
        logger.info(`[Harness] 生成 ${r.commands.length} 条命令`)
      } catch (e) {
        logger.warn(`[Parse] harness 失败，回退单次 LLM: ${(e as Error).message}`)
        parsed = undefined
      }
    }

    // 2. 需要的话回退到单次 LLM 解析
    let valid: NativeCommand[]
    let rejected: string[]
    let explanation = ''
    let raw: string | undefined

    if (parsed && Array.isArray(parsed.commands)) {
      const s = await sanitizeCommands(parsed.commands)
      valid = s.valid
      rejected = s.rejected
      explanation = parsed.explanation || ''
    } else {
      // LLM 不可用 / harness 结果里没有命令时，走单次 LLM 兜底
      const completion = await openai.chat.completions.create({
        model: config.llmModel,
        messages: [
          { role: 'system', content: PHOTOCRAFT_SYSTEM_PROMPT },
          { role: 'user', content: String(message) },
        ],
        temperature: 0.2,
        max_tokens: 2048,
      })
      const content = completion.choices[0]?.message?.content || ''
      const p = extractParsed(content)
      const s = await sanitizeCommands(p.commands)
      valid = s.valid
      rejected = s.rejected
      explanation = p.explanation || ''
      raw = content.slice(0, 500)
    }

    if (rejected.length) {
      logger.warn(`[Parse] 丢弃了 ${rejected.length} 条无效命令: ${rejected.slice(0, 5).join(', ')}`)
    }

    res.json({
      commands: valid,
      explanation,
      tool: cliTool,
      rejected: rejected.length ? rejected : undefined,
      raw,
    })

    logger.info(`[Parse] Generated ${valid.length} commands`)
  } catch (error: unknown) {
    const err = error as Error
    logger.error(`[Parse] Error: ${err.message}`, err)
    res.status(500).json({ error: '指令解析失败', detail: err.message })
  }
})

export { parse }
