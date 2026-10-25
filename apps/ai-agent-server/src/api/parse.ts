import { Router, Request, Response } from 'express'
import { STUDIO_SYSTEM_PROMPT, ALL_STUDIO_KEYS } from '../core/studio-prompts.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import OpenAI from 'openai'

const parse = Router()

const openai = new OpenAI({
  baseURL: config.llmApiUrl,
  apiKey: config.llmApiKey,
})

/**
 * POST /api/parse — Parse user instruction into Studio adjustment commands.
 * Plan B: browser executes commands directly, no image upload needed.
 */
parse.post('/', async (req: Request, res: Response) => {
  const { message, tool } = req.body
  const cliTool = tool === 'lightcraft' ? 'lightcraft' : 'photocraft'

  if (!message) {
    res.status(400).json({ error: '缺少 message 字段' })
    return
  }

  try {
    logger.info(`[Parse] (${cliTool}) ${message.slice(0, 80)}`)

    // LightCraft 和 PhotoCraft 目前共用同一份 Studio 提示词；
    // LightCraft 专属提示词补齐后再按 cliTool 分叉。
    const systemPrompt = STUDIO_SYSTEM_PROMPT

    const completion = await openai.chat.completions.create({
      model: config.llmModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    })

    const content = completion.choices[0]?.message?.content || ''

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn('[Parse] LLM returned non-JSON response')
      res.json({
        commands: [],
        explanation: '无法解析指令，请尝试更具体的描述',
        raw: content.slice(0, 500),
      })
      return
    }

    let parsed: { commands?: { key: string; value: number }[]; explanation?: string }
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch (error) {
      logger.error('[Parse] Failed to parse LLM JSON', { error: (error as Error).message })
      res.json({
        commands: [],
        explanation: '指令解析失败，请重新描述',
      })
      return
    }

    if (!parsed.commands || !Array.isArray(parsed.commands)) {
      res.json({
        commands: [],
        explanation: '指令解析失败，请重新描述',
      })
      return
    }

    // Validate: filter out unknown keys, clamp values
    const validCommands: { key: string; value: number }[] = []
    for (const cmd of parsed.commands) {
      if (!cmd.key || typeof cmd.value !== 'number') continue
      // Allow preset keys and all studio adjustment keys
      if (ALL_STUDIO_KEYS.includes(cmd.key)) {
        // Clamp to reasonable range
        const v = Math.max(-1, Math.min(1, cmd.value))
        validCommands.push({ key: cmd.key, value: v })
      }
    }

    res.json({
      commands: validCommands,
      explanation: parsed.explanation || '',
      tool: cliTool,
    })

    logger.info(`[Parse] Generated ${validCommands.length} commands`)
  } catch (error: unknown) {
    const err = error as Error
    logger.error(`[Parse] Error: ${err.message}`, err)
    res.status(500).json({
      error: '指令解析失败',
      detail: err.message,
    })
  }
})

export { parse }
