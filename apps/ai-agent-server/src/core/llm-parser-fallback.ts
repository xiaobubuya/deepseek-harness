import OpenAI from 'openai'
import { config } from '../config.js'

/**
 * Fallback LLM Parser
 * Direct LLM API call when DeepSeek Harness is not available.
 */

const SYSTEM_PROMPT = `你是一个照片编辑助手。用户会用自然语言描述照片编辑需求，你需要将其转换为 PhotoCraft CLI 命令。

## 可用命令

### 色彩调整
- color.temperature {value: -100~100} — 调整色温（负值偏蓝，正值偏暖）
- color.saturation {value: 0~200} — 调整饱和度
- color.brightness {value: -100~100} — 调整亮度
- color.contrast {value: -100~100} — 调整对比度
- color.hue {value: 0~360} — 调整色相
- color.exposure {value: -100~100} — 调整曝光

### 滤镜
- filter.warm {} — 暖色调滤镜
- filter.cool {} — 冷色调滤镜
- filter.blackwhite {} — 黑白滤镜
- filter.sepia {} — 怀旧滤镜
- filter.vintage {} — 复古滤镜

### 效果
- sharpen {strength: 0~100} — 锐化
- denoise {strength: 0~100} — 降噪
- blur {radius: 1~50} — 模糊
- vignette {strength: 0~100} — 暗角
- grain {amount: 0~100} — 添加颗粒

### 变换
- resize {width: number, height: number} — 调整大小
- crop {x: number, y: number, width: number, height: number} — 裁剪
- rotate {angle: number} — 旋转
- flip {horizontal: boolean} — 翻转

## 返回格式

你必须返回严格的 JSON 格式：
{"commands": [{"cmd": "命令名", "params": {"参数名": 值}}], "explanation": "简短说明"}

## 示例

用户: "把天空调蓝一点"
返回: {"commands": [{"cmd": "color.temperature", "params": {"value": -50}}], "explanation": "降低了色温，让天空更蓝"}

用户: "给照片加暖色调，然后锐化一下"
返回: {"commands": [{"cmd": "filter.warm", "params": {}}, {"cmd": "sharpen", "params": {"strength": 50}}], "explanation": "应用了暖色调滤镜并进行了锐化"}

用户: "让照片看起来更专业"
返回: {"commands": [{"cmd": "color.contrast", "params": {"value": 20}}, {"cmd": "color.saturation", "params": {"value": 120}}, {"cmd": "sharpen", "params": {"strength": 40}}], "explanation": "增强了对比度和饱和度，并进行了适度锐化"}

注意：只返回 JSON，不要包含其他文字。`

const openai = new OpenAI({
  baseURL: config.llmApiUrl,
  apiKey: config.llmApiKey,
})

export interface LLMResult {
  commands: { cmd: string; params: Record<string, unknown> }[]
  explanation: string
}

/**
 * Parse user instruction via direct LLM API call.
 */
export async function parseInstructionFallback(
  userMessage: string,
  onThinking?: (thought: string) => void,
): Promise<LLMResult> {
  onThinking?.('正在分析您的指令...')

  const completion = await openai.chat.completions.create({
    model: config.llmModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  })

  const content = completion.choices[0]?.message?.content || ''
  onThinking?.('正在解析命令...')

  return parseResponse(content)
}

function parseResponse(content: string): LLMResult {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('LLM 返回格式错误，无法解析 JSON')
  }

  const parsed = JSON.parse(jsonMatch[0])

  if (!parsed.commands || !Array.isArray(parsed.commands)) {
    throw new Error('LLM 返回格式错误，缺少 commands 字段')
  }

  return {
    commands: parsed.commands,
    explanation: parsed.explanation || '',
  }
}
