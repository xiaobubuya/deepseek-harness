import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const execFileAsync = promisify(execFile)

/**
 * PhotoCraft CLI command schema for the Harness agent system prompt.
 * Focus: color grading, filters, effects.
 */
const PHOTOCRAFT_SCHEMA = `
## PhotoCraft CLI Commands (调色工具)

Available commands for photo color grading and effects:

### Color Adjustment
- color.temperature {value: -100~100} — Adjust color temperature (negative=cool, positive=warm)
- color.saturation {value: 0~200} — Adjust saturation
- color.brightness {value: -100~100} — Adjust brightness
- color.contrast {value: -100~100} — Adjust contrast
- color.hue {value: 0~360} — Adjust hue rotation
- color.exposure {value: -100~100} — Adjust exposure

### Filters
- filter.warm {} — Warm tone filter
- filter.cool {} — Cool tone filter
- filter.blackwhite {} — Black & white filter
- filter.sepia {} — Sepia filter
- filter.vintage {} — Vintage filter

### Effects
- sharpen {strength: 0~100} — Sharpen image
- denoise {strength: 0~100} — Reduce noise
- blur {radius: 1~50} — Apply blur
- vignette {strength: 0~100} — Add vignette
- grain {amount: 0~100} — Add film grain

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
 * LightCraft CLI command schema for the Harness agent system prompt.
 * Focus: retouching, dodging/burning, non-destructive adjustments.
 */
const LIGHTCRAFT_SCHEMA = `
## LightCraft CLI Commands (修图工具)

Available commands for photo retouching and non-destructive editing:

### Light Adjustments
- light.exposure {value: -100~100} — Adjust overall exposure
- light.contrast {value: -100~100} — Adjust contrast
- light.highlights {value: -100~100} — Adjust highlights
- light.shadows {value: -100~100} — Adjust shadows
- light.whites {value: -100~100} — Adjust whites point
- light.blacks {value: -100~100} — Adjust blacks point
- light.texture {value: -100~100} — Adjust texture/clarity

### Color Adjustments
- color.temperature {value: -100~100} — Adjust color temperature
- color.tint {value: -100~100} — Adjust tint (green-magenta)
- color.saturation {value: 0~200} — Adjust saturation
- color.vibrance {value: 0~200} — Adjust vibrance
- color.hue {value: 0~360} — Adjust hue rotation
- color.luminance {value: -100~100} — Adjust luminance

### Retouching
- retouch.dodge {value: 0~100} — Brighten areas (dodge)
- retouch.burn {value: 0~100} — Darken areas (burn)
- retouch.clarity {value: -100~100} — Adjust clarity/midtone contrast
- retouch.dehaze {value: -100~100} — Reduce haze/fog
- retouch.smooth {value: 0~100} — Smooth skin
- retouch.blemish {value: 0~100} — Remove blemishes

### Effects
- sharpen {strength: 0~100} — Sharpen image
- denoise {strength: 0~100} — Reduce noise
- blur {radius: 1~50} — Apply blur
- vignette {strength: 0~100} — Add vignette
- grain {amount: 0~100} — Add film grain

### Transformations
- resize {width: number, height: number} — Resize
- crop {x: number, y: number, width: number, height: number} — Crop
- rotate {angle: number} — Rotate
- flip {horizontal: boolean} — Flip

## Required Output Format

You MUST return a JSON object with this exact structure:
{"commands": [{"cmd": "command_name", "params": {"param": value}}], "explanation": "brief explanation"}

Examples:
User: "Smooth the skin and brighten"
Output: {"commands": [{"cmd": "retouch.smooth", "params": {"value": 40}}, {"cmd": "light.exposure", "params": {"value": 30}}], "explanation": "Smoothed skin and increased exposure"}

User: "Add clarity and reduce haze"
Output: {"commands": [{"cmd": "retouch.clarity", "params": {"value": 30}}, {"cmd": "retouch.dehaze", "params": {"value": 20}}], "explanation": "Added midtone clarity and reduced haze"}

Only return JSON, no other text.`

/**
 * Get the appropriate schema based on tool.
 */
function getSchema(tool: string): string {
  return tool === 'lightcraft' ? LIGHTCRAFT_SCHEMA : PHOTOCRAFT_SCHEMA;
}

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
 * Generate a Harness profile patch to override the model.
 * Returns the path to the generated patch file.
 */
function generateModelPatch(model: string): string {
  const patchContent = `- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${model}
`
  const patchPath = join(tmpdir(), `dsh-model-patch-${Date.now()}.yml`)
  writeFileSync(patchPath, patchContent, 'utf-8')
  return patchPath
}

/**
 * Call DeepSeek Harness headless mode to parse a user instruction.
 * Returns the raw text output (expected to be JSON with commands).
 */
export async function callHarnessAgent(
  userMessage: string,
  onThinking?: (thought: string) => void,
  tool: string = 'photocraft',
): Promise<string> {
  onThinking?.(`Harness agent (${tool}) 正在分析指令...`)

  const schema = getSchema(tool);
  const task = `${schema}\n\nUser instruction: "${userMessage}"`

  // Generate model patch
  const patchPath = generateModelPatch(config.llmModel)

  const args = [
    '--profile', 'headless',
    '--patch', patchPath,
    '--permission-mode', 'danger-full-access',
    '--json',
    task,
  ]

  try {
    const result = await Promise.race([
      execFileAsync(config.harnessCli, args, {
        timeout: config.taskTimeout * 2,
        maxBuffer: 10 * 1024 * 1024,
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
  } finally {
    // Clean up patch file
    try {
      unlinkSync(patchPath)
    } catch {
      // ignore cleanup errors
    }
  }
}
