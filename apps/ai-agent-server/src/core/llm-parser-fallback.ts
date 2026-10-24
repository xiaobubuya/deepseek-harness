import OpenAI from 'openai'
import { config } from '../config.js'

const openai = new OpenAI({
  baseURL: config.llmApiUrl,
  apiKey: config.llmApiKey,
})

export interface LLMResult {
  commands: { cmd: string; params: Record<string, unknown> }[]
  explanation: string
}

const PHOTO_SYSTEM_PROMPT = `你是一个照片编辑助手（调色工具 PhotoCraft）。用户会用自然语言描述照片编辑需求，你需要将其转换为 PhotoCraft CLI 命令。

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

注意：只返回 JSON，不要包含其他文字。`

const LIGHT_SYSTEM_PROMPT = `你是一个照片修图助手（修图工具 LightCraft）。用户会用自然语言描述照片修图需求，你需要将其转换为 LightCraft CLI 命令。

## 可用命令

### 光影调整
- light.exposure {value: -100~100} — 调整曝光
- light.contrast {value: -100~100} — 调整对比度
- light.highlights {value: -100~100} — 调整高光
- light.shadows {value: -100~100} — 调整阴影
- light.whites {value: -100~100} — 调整白色色阶
- light.blacks {value: -100~100} — 调整黑色色阶
- light.texture {value: -100~100} — 调整质感

### 色彩调整
- color.temperature {value: -100~100} — 调整色温
- color.tint {value: -100~100} — 调整色调（绿-洋红）
- color.saturation {value: 0~200} — 调整饱和度
- color.vibrance {value: 0~200} — 调整自然饱和度
- color.hue {value: 0~360} — 调整色相
- color.luminance {value: -100~100} — 调整明度

### 修图
- retouch.dodge {value: 0~100} — 提亮（ Dodge ）
- retouch.burn {value: 0~100} — 压暗（ Burn ）
- retouch.clarity {value: -100~100} — 调整清晰度
- retouch.dehaze {value: -100~100} — 去雾
- retouch.smooth {value: 0~100} — 磨皮
- retouch.blemish {value: 0~100} — 修复瑕疵

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
用户: "磨皮一下，然后提亮"
返回: {"commands": [{"cmd": "retouch.smooth", "params": {"value": 40}}, {"cmd": "light.exposure", "params": {"value": 30}}], "explanation": "磨皮并提高了曝光"}

用户: "加清晰度，去雾"
返回: {"commands": [{"cmd": "retouch.clarity", "params": {"value": 30}}, {"cmd": "retouch.dehaze", "params": {"value": 20}}], "explanation": "增加了清晰度并去除雾气"}

注意：只返回 JSON，不要包含其他文字。`

function getSystemPrompt(tool: string): string {
  return tool === 'lightcraft' ? LIGHT_SYSTEM_PROMPT : PHOTO_SYSTEM_PROMPT
}

export async function parseInstructionFallback(
  userMessage: string,
  onThinking?: (thought: string) => void,
  tool: string = 'photocraft',
): Promise<LLMResult> {
  onThinking?.(`正在分析您的指令 (${tool})...`)

  const completion = await openai.chat.completions.create({
    model: config.llmModel,
    messages: [
      { role: 'system', content: getSystemPrompt(tool) },
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
