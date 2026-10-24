import { callHarnessAgent } from './harness-agent.js'
import { logger } from '../utils/logger.js'

/**
 * LLM Parser
 * Delegates to DeepSeek Harness headless mode to convert
 * natural language instructions into PhotoCraft CLI commands.
 */

export interface LLMResult {
  commands: { cmd: string; params: Record<string, unknown> }[]
  explanation: string
}

/**
 * Parse a user instruction into PhotoCraft CLI commands
 * by calling the DeepSeek Harness agent.
 */
export async function parseInstruction(
  userMessage: string,
  onThinking?: (thought: string) => void,
): Promise<LLMResult> {
  logger.info(`Parsing instruction: ${userMessage.slice(0, 100)}`)

  const rawOutput = await callHarnessAgent(userMessage, onThinking)
  return parseResponse(rawOutput)
}

/**
 * Parse Harness agent output into structured commands.
 */
function parseResponse(content: string): LLMResult {
  // Try to extract JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    logger.error('Harness agent returned non-JSON response', { content: content.slice(0, 500) })
    throw new Error('Harness agent 返回格式错误，无法解析 JSON')
  }

  let parsed: { commands?: { cmd: string; params: Record<string, unknown> }[]; explanation?: string }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch (error) {
    logger.error('Failed to parse Harness agent JSON', { error: (error as Error).message })
    throw new Error('Harness agent 返回的 JSON 格式无效')
  }

  if (!parsed.commands || !Array.isArray(parsed.commands)) {
    throw new Error('Harness agent 返回格式错误，缺少 commands 字段')
  }

  return {
    commands: parsed.commands,
    explanation: parsed.explanation || '',
  }
}
