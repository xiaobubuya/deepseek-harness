import OpenAI from 'openai';
import { config } from '../config.js';
import { callHarnessAgent, type HarnessOptions } from './harness-agent.js';
import { logger } from '../utils/logger.js';

/**
 * 指令解析器（chat / ws 链路）
 *
 * 优先走 DeepSeek Harness `dsh headless --json`（支持一句话多次修改，一次产出多命令），
 * harness 不可用或没产出命令时回退单次 LLM。命令统一以 `{cmd, params}` 形状返回，
 * 供 `chat.ts` → `cli-executor.ts`（serve gateway）消费。
 */

const SYSTEM_PROMPT = `你是一个照片编辑助手。用户用自然语言描述照片编辑需求，你将其转换为真实的 PhotoCraft 引擎命令（ID 采用 Photoshop 风格）。命令通过 photocraft-cli serve 的 engine.execute（JSON-RPC）执行，可调用完整命令注册表。

## 可用命令（真实 engine command id）

### 色彩 / 明暗调整
- image.adjustments.brightnessContrast {brightness: -150..150, contrast: -50..100} — 亮度/对比度
- image.adjustments.exposure {exposure: -20..20, offset: -0.5..0.5, gamma: 0.01..9.99} — 曝光
- image.adjustments.vibrance {vibrance: -100..100, saturation: -100..100} — 自然饱和度/饱和度
- image.adjustments.hueSaturation {hue: -180..180, saturation: -100..100, lightness: -100..100} — 色相/饱和度
- image.adjustments.shadowsHighlights {shadowAmount: 0..100, highlightAmount: 0..100, midtone: -100..100} — 阴影/高光
- image.adjustments.levels {inBlack: 0..253, gamma: 0.01..9.99, inWhite: 2..255, outBlack: 0..255, outWhite: 0..255} — 色阶
- image.adjustments.curves {points: [[in,out],…]} — 曲线（2..19 个点，0..255）
- image.adjustments.photoFilter {filter: "warming85"|"cooling80"|"sepia"|..., density: 0..100} — 照片滤镜/色温（暖=warming85，冷=cooling80）
- image.adjustments.blackWhite {} — 黑白
- image.adjustments.desaturate {} — 去饱和
- image.mode.grayscale {} — 灰度
- image.adjustments.colorLookup {lut: "warm"|"cool"|"bleachBypass"|"fadedFilm"|"tealOrange"|"crossProcess"} — 复古/胶片 LUT

### 效果 / 滤镜
- filter.sharpen.unsharpMask {amount: 1..500, radius: 0.1..1000, threshold: 0..255} — 锐化（细节锐化）
- filter.sharpen.sharpen {} — 锐化（简单）
- filter.noise.reduceNoise {strength: 0..10, preserveDetails: 0..100} — 降噪
- filter.blur.gaussianBlur {radius: 0.1..1000} — 高斯模糊
- filter.noise.addNoise {amount: 0.1..400, distribution: "uniform"|"gaussian", monochromatic: true} — 添加颗粒/噪点
- filter.lensCorrection {vignetteAmount: -100..100, vignetteMidpoint: 0..100, angle: -180..180} — 暗角/镜头校正

### 变换
- image.imageSize {width, height} — 调整画布尺寸（重采样）
- image.crop {x, y, width, height} — 裁剪
- image.imageRotation.flipCanvasHorizontal {} — 水平翻转
- image.imageRotation.flipCanvasVertical {} — 垂直翻转
- image.imageRotation.90cw {} — 顺时针旋转 90°
- image.imageRotation.90ccw {} — 逆时针旋转 90°
- image.imageRotation.180 {} — 旋转 180°

所有命令可叠加（同一张图片连续执行）。

## 返回格式

你必须返回严格的 JSON 格式：
{"commands": [{"cmd": "真实命令ID", "params": {"参数名": 值}}], "explanation": "简短说明"}

## 示例

用户: "把天空调蓝一点"
返回: {"commands": [{"cmd": "image.adjustments.photoFilter", "params": {"filter": "cooling80", "density": 40}}], "explanation": "降低了色温，让天空更蓝"}

用户: "给照片加暖色调，然后锐化一下"
返回: {"commands": [{"cmd": "image.adjustments.photoFilter", "params": {"filter": "warming85", "density": 30}}, {"cmd": "filter.sharpen.unsharpMask", "params": {"amount": 80, "radius": 1.2}}], "explanation": "应用了暖色调滤镜并进行了锐化"}

用户: "让照片看起来更专业"
返回: {"commands": [{"cmd": "image.adjustments.brightnessContrast", "params": {"brightness": 15, "contrast": 12}}, {"cmd": "image.adjustments.vibrance", "params": {"vibrance": 20}}, {"cmd": "filter.sharpen.unsharpMask", "params": {"amount": 60, "radius": 1}}], "explanation": "增强了对比度和饱和度，并进行了适度锐化"}

用户: "变成黑白怀旧风格"
返回: {"commands": [{"cmd": "image.adjustments.blackWhite", "params": {}}, {"cmd": "image.adjustments.colorLookup", "params": {"lut": "fadedFilm"}}], "explanation": "转为黑白并添加陈旧胶片质感"}

注意：只返回 JSON，不要包含其他文字。`;

const openai = new OpenAI({
  baseURL: config.llmApiUrl,
  apiKey: config.llmApiKey,
});

export interface LLMResult {
  commands: { cmd: string; params: Record<string, unknown> }[];
  explanation: string;
}

/**
 * 解析用户指令
 */
export async function parseInstruction(
  userMessage: string,
  onThinking?: (thought: string) => void,
  options?: HarnessOptions
): Promise<LLMResult> {
  onThinking?.('正在分析您的指令...');

  // 优先走 harness agent（可多步规划，一句话多次修改一次产出多命令）
  if (config.harnessEnabled) {
    try {
      const r = await callHarnessAgent(userMessage, onThinking, options);
      if (r.commands.length) {
        const commands = r.commands.map((c) => ({ cmd: c.id, params: c.params }));
        onThinking?.('解析命令完成');
        return { commands, explanation: r.explanation };
      }
      logger.warn('[LLM-Parser] harness 未产出命令，回退单次 LLM');
    } catch (e) {
      logger.warn(`[LLM-Parser] harness 失败，回退单次 LLM: ${(e as Error).message}`);
    }
  }

  const completion = await openai.chat.completions.create({
    model: config.llmModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  });

  const content = completion.choices[0]?.message?.content || '';
  onThinking?.('正在解析命令...');

  return parseResponse(content);
}

/**
 * 解析 LLM 响应
 */
function parseResponse(content: string): LLMResult {
  // 尝试提取 JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM 返回格式错误，无法解析 JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);

  if (!parsed.commands || !Array.isArray(parsed.commands)) {
    throw new Error('LLM 返回格式错误，缺少 commands 字段');
  }

  return {
    commands: parsed.commands,
    explanation: parsed.explanation || '',
  };
}
