/**
 * Harness agent 指令解析器。
 *
 * 用 DeepSeek Harness 的 `dsh --profile headless --json` 把一条自然语言修图指令
 * 解析成 PhotoCraft 原生命令 JSON（`{commands:[{id,params}], explanation}`），
 * 替代单次 LLM 调用。headless agent 有推理/多步规划能力，能一次产出「一句话多次修改」
 * 所需的一组命令，而不只是一次 LLM 的弱 JSON。
 *
 * 关键：headless profile 内置 `@deepseek-ai/dsh-llm-pi-ai`，用 `--patch` 注入
 * SiliconFlow 的 OpenAI 兼容路由（无需改 profile 文件、无需 DeepSeek 官方 key）。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { PHOTOCRAFT_AGENT_PROMPT } from './photocraft-prompts.js';
import { renderVisionBlock, type VisionSummary } from './vision-context.js';

const execFileAsync = promisify(execFile);

/** 一条 PhotoCraft 原生命令。 */
export interface NativeCommand {
  id: string;
  params: Record<string, unknown>;
}

/** Harness agent 解析结果。 */
export interface HarnessParseResult {
  commands: NativeCommand[];
  explanation: string;
  raw: string;
}

/**
 * 从 `dsh headless --json` 的 JSONL 事件流里取 `final` 事件的 `text`。
 */
function parseHarnessOutput(stdout: string): string {
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; text?: string };
      if (event.type === 'final' && typeof event.text === 'string') {
        return event.text;
      }
    } catch {
      // 忽略非 JSON 行（日志、告警等）
    }
  }
  throw new Error('Harness agent 没有返回 final 事件');
}

/**
 * 生成一段注入 SiliconFlow 路由的 Harness profile patch 内容。
 * `baseURL` 使用 ai-agent-server 配置的 LLM API（SiliconFlow OpenAI 兼容端点）。
 */
function renderPatch(): string {
  const baseURL = config.llmApiUrl.replace(/\/+$/, ''); // 去掉末尾斜杠
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: siliconflow',
    `    model: ${config.llmModel}`,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      siliconflow:',
    '        apiKeyEnv: LLM_API_KEY',
    '        api: openai-completions',
    `        baseURL: ${baseURL}`,
    '        models:',
    `          - id: ${config.llmModel}`,
    '            contextWindow: 131072',
    '',
  ].join('\n');
}

/** 传给 harness agent 的可选上下文。 */
export interface HarnessOptions {
  /** 视觉分析摘要：让 agent 知道画面里有什么、在哪个区域，用于生成定位类命令。 */
  vision?: VisionSummary
  /** 文档真实像素尺寸，用于把相对坐标换算成像素。 */
  docSize?: { w: number; h: number }
}

/**
 * 调 Harness headless 生成 PhotoCraft 命令。
 * @param message 用户自然语言指令
 * @param onThinking 过程回调（可选）
 * @param options 视觉摘要等可选上下文
 */
export async function callHarnessAgent(
  message: string,
  onThinking?: (t: string) => void,
  options?: HarnessOptions
): Promise<HarnessParseResult> {
  onThinking?.('Harness agent 正在分析指令...');
  logger.info('[Harness] 开始解析指令(单次调用，支持多步规划)');

  // 任务正文：不带硬编码命令清单，要求 agent 用 photocraft-cli commands 自行按需查询
  // 引擎的 920 个真实命令（全量塞 prompt 约 25K tokens，不现实）。
  const parts = [PHOTOCRAFT_AGENT_PROMPT, ''];
  if (options?.vision) {
    parts.push(renderVisionBlock(options.vision, options.docSize), '');
    logger.info(`[Harness] 已注入视觉摘要（主体: ${options.vision.subject.name}）`);
  }
  parts.push(`用户需求：${message}`);
  const task = parts.join('\n');

  const patchPath = join(tmpdir(), `dsh-pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yml`);
  writeFileSync(patchPath, renderPatch(), 'utf-8');

  const args = ['--profile', 'headless', '--patch', patchPath, '--json', task];

  try {
    const result = await Promise.race([
      execFileAsync(config.harnessCli, args, {
        timeout: config.taskTimeout * 2,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          LLM_API_KEY: config.llmApiKey,
          DSH_TELEMETRY_DISABLED: '1',
          // full access：agent 需要执行 `photocraft-cli commands` 查询命令清单。
          // dsh-base 的 approval 配置据此把 policy 从 'ask' 切成 'never'，
          // 否则 headless 无审批通道，bash 调用会被直接拒绝。
          DSH_PERMISSION_MODE: 'danger-full-access',
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Harness agent 超时(${config.taskTimeout * 2}ms)`)), config.taskTimeout * 2)
      ),
    ]);

    logger.info('[Harness] agent 完成');
    const text = parseHarnessOutput(result.stdout);

    // 从 text 里提取 JSON（agent 可能带少量前后文）。
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let parsed: { commands?: unknown; explanation?: string } = {};
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        logger.warn('[Harness] final 不是合法 JSON，按空命令处理');
      }
    }

    const commands: NativeCommand[] = [];
    if (Array.isArray(parsed.commands)) {
      for (const raw of parsed.commands as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const cmd = raw as { id?: unknown; params?: unknown };
        const id = typeof cmd.id === 'string' ? cmd.id : '';
        const params: Record<string, unknown> =
          cmd.params && typeof cmd.params === 'object' ? (cmd.params as Record<string, unknown>) : {};
        if (id) commands.push({ id, params });
      }
    }

    onThinking?.('解析命令完成');
    return {
      commands,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
      raw: text,
    };
  } catch (error) {
    const err = error as Error;
    logger.error('[Harness] agent 调用失败', err);
    throw new Error(`Harness agent 错误: ${err.message}`);
  } finally {
    try {
      unlinkSync(patchPath);
    } catch {
      // 清理失败可忽略
    }
  }
}
