import { execFile } from 'child_process'
import { promisify } from 'util'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const execFileAsync = promisify(execFile)

/**
 * PhotoCraft CLI command schema for the Harness agent system prompt.
 */
const PHOTOCRAFT_SCHEMA = `
## PhotoCraft CLI Commands

Available commands for photo editing:

### Color Adjustment
- color.temperature {value: -100~100} — Adjust color temperature
- color.saturation {value: 0~200} — Adjust saturation
- color.brightness {value: -100~100} — Adjust brightness
- color.contrast {value: -100~100} — Adjust contrast
- color.hue {value: 0~360} — Adjust hue
- color.exposure {value: -100~100} — Adjust exposure

### Filters
- filter.warm {} — Warm tone filter
- filter.cool {} — Cool tone filter
- filter.blackwhite {} — Black & white filter
- filter.sepia {} — Sepia filter
- filter.vintage {} — Vintage filter

### Effects
- sharpen {strength: 0~100} — Sharpen
- denoise {strength: 0~100} — Denoise
- blur {radius: 1~50} — Blur
- vignette {strength: 0~100} — Vignette
- grain {amount: 0~100} — Add grain

### Transformations
- resize {width: number, height: number} — Resize
- crop {x: number, y: number, width: number, height: number} — Crop
- rotate {angle: number} — Rotate
- flip {horizontal: boolean} — Flip

## Required Output Format

You MUST return a JSON object with this exact structure:
{"commands": [{"cmd": "command_name", "params": {"param": value}}], "explanation": "brief explanation"}

Examples:
User: "Make the sky bluer"
Output: {"commands": [{"cmd": "color.temperature", "params": {"value": -50}}], "explanation": "Lowered color temperature to make sky bluer"}

User: "Add warm tone and sharpen"
Output: {"commands": [{"cmd": "filter.warm", "params": {}}, {"cmd": "sharpen", "params": {"strength": 50}}], "explanation": "Applied warm filter and sharpened"}

Only return JSON, no other text.`

/**
 * JSONL event types from `dsh headless --json`.
 */
interface HarnessEvent {
  type: string
  [key: string]: unknown
}

/**
 * Parse JSONL output from `dsh headless --json`.
 * Returns the `text` field from the `final` event.
 */
function parseHarnessOutput(stdout: string): string {
  const lines = stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as HarnessEvent
      if (event.type === 'final' && typeof event.text === 'string') {
        return event.text
      }
    } catch {
      // skip non-JSON lines
    }
  }
  throw new Error('Harness agent did not return a final event')
}

/**
 * Call DeepSeek Harness headless mode to parse a user instruction.
 * Returns the raw text output (expected to be JSON with commands).
 */
export async function callHarnessAgent(
  userMessage: string,
  onThinking?: (thought: string) => void,
): Promise<string> {
  onThinking?.('Harness agent 正在分析指令...')

  const task = `${PHOTOCRAFT_SCHEMA}\n\nUser instruction: "${userMessage}"`

  const args = [
    '--profile', 'headless',
    '--permission-mode', 'danger-full-access',
    '--json',
    task,
  ]

  try {
    const result = await Promise.race([
      execFileAsync(config.harnessCli, args, {
        timeout: config.taskTimeout * 2,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...process.env,
          DSH_PERMISSION_MODE: 'danger-full-access',
          DSH_TELEMETRY_DISABLED: '1',
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Harness agent timeout (${config.taskTimeout * 2}ms)`)), config.taskTimeout * 2),
      ),
    ])

    logger.info('Harness agent completed')
    const output = parseHarnessOutput(result.stdout)
    onThinking?.('解析命令...')
    return output
  } catch (error: unknown) {
    const err = error as { message: string; stderr?: string }
    logger.error('Harness agent failed', err)
    throw new Error(`Harness agent error: ${err.stderr || err.message}`)
  }
}
