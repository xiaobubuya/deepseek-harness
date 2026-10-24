import { callHarnessAgent } from './harness-agent.js'
import { parseInstructionFallback } from './llm-parser-fallback.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

/**
 * LLM Parser
 * Primary: DeepSeek Harness headless mode
 * Fallback: Direct LLM API call (when Harness not available)
 */

export interface LLMResult {
  commands: { cmd: string; params: Record<string, unknown> }[]
  explanation: string
}

/**
 * Check if Harness CLI is available.
 */
async function isHarnessAvailable(): Promise<boolean> {
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    await execFileAsync(config.harnessCli, ['--version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Parse a user instruction into PhotoCraft CLI commands.
 */
export async function parseInstruction(
  userMessage: string,
  onThinking?: (thought: string) => void,
): Promise<LLMResult> {
  logger.info(`Parsing instruction: ${userMessage.slice(0, 100)}`)

  // Try Harness first
  if (await isHarnessAvailable()) {
    logger.info('Using DeepSeek Harness agent')
    try {
      const rawOutput = await callHarnessAgent(userMessage, onThinking)
      return parseResponse(rawOutput)
    } catch (error) {
      logger.warn('Harness agent failed, falling back to LLM', error)
    }
  } else {
    logger.warn('Harness CLI not available, using direct LLM')
  }

  // Fallback: direct LLM call
  return parseInstructionFallback(userMessage, onThinking)
}

/**
 * Parse Harness agent output into structured commands.
 */
function parseResponse(content: string): LLMResult {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    logger.error('Agent returned non-JSON response', { content: content.slice(0, 500) })
    throw new Error('Agent 返回格式错误，无法解析 JSON')
  }

  let parsed: { commands?: { cmd: string; params: Record<string, unknown> }[]; explanation?: string }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch (error) {
    logger.error('Failed to parse agent JSON', { error: (error as Error).message })
    throw new Error('Agent 返回的 JSON 格式无效')
  }

  if (!parsed.commands || !Array.isArray(parsed.commands)) {
    throw new Error('Agent 返回格式错误，缺少 commands 字段')
  }

  return {
    commands: parsed.commands,
    explanation: parsed.explanation || '',
  }
}
