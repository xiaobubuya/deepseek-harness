import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export interface ExecutionProgress {
  step: number;
  total: number;
  message: string;
  command: string;
  params: Record<string, unknown>;
}

export interface ExecutionResult {
  status: 'success' | 'error';
  outputPath: string;
  logs: string[];
  error?: string;
}

export interface ExecutionCallbacks {
  onProgress?: (progress: ExecutionProgress) => void;
  onLog?: (log: string) => void;
}

export type Tool = 'photocraft' | 'lightcraft';

/**
 * 命令白名单 — PhotoCraft
 */
const PHOTO_COMMANDS = new Set([
  'color.temperature', 'color.saturation', 'color.brightness', 'color.contrast',
  'color.hue', 'color.exposure',
  'filter.warm', 'filter.cool', 'filter.blackwhite', 'filter.sepia', 'filter.vintage',
  'sharpen', 'denoise', 'blur', 'vignette', 'grain',
  'resize', 'crop', 'rotate', 'flip',
]);

/**
 * 命令白名单 — LightCraft
 */
const LIGHT_COMMANDS = new Set([
  'light.exposure', 'light.contrast', 'light.highlights', 'light.shadows',
  'light.whites', 'light.blacks', 'light.texture',
  'color.temperature', 'color.tint', 'color.saturation', 'color.vibrance',
  'color.hue', 'color.luminance',
  'retouch.dodge', 'retouch.burn', 'retouch.clarity', 'retouch.dehaze',
  'retouch.smooth', 'retouch.blemish',
  'sharpen', 'denoise', 'blur', 'vignette', 'grain',
  'resize', 'crop', 'rotate', 'flip',
]);

export function getAllowedCommands(tool: Tool = 'photocraft'): Set<string> {
  return tool === 'lightcraft' ? LIGHT_COMMANDS : PHOTO_COMMANDS;
}

export function validateCommand(cmd: string, params: Record<string, unknown>, tool: Tool = 'photocraft'): string | null {
  const allowed = getAllowedCommands(tool);
  if (!allowed.has(cmd)) {
    return `不支持的命令: ${cmd} (工具: ${tool})`;
  }
  const jsonString = JSON.stringify(params);
  const dangerousChars = [';', '|', '&', '$', '`', '\n', '\r'];
  for (const char of dangerousChars) {
    if (jsonString.includes(char)) {
      return `参数包含危险字符: ${char}`;
    }
  }
  return null;
}

function buildCLIArgs(
  command: { cmd: string; params: Record<string, unknown> },
  inputPath: string,
  outputPath: string
): string[] {
  return [
    'run', inputPath,
    '--cmd', command.cmd,
    '--params', JSON.stringify(command.params),
    '--out', outputPath,
  ];
}

function getCLIBinary(tool: Tool): string {
  return tool === 'lightcraft' ? config.lightcraftCli : config.photocraftCli;
}

async function executeCommand(
  command: { cmd: string; params: Record<string, unknown> },
  inputPath: string,
  outputPath: string,
  callbacks: ExecutionCallbacks,
  tool: Tool
): Promise<ExecutionResult> {
  const cliPath = getCLIBinary(tool);
  const args = buildCLIArgs(command, inputPath, outputPath);

  try {
    const result = await Promise.race([
      execFileAsync(cliPath, args, { timeout: config.taskTimeout }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`命令超时 (${config.taskTimeout}ms)`)), config.taskTimeout)
      ),
    ]);

    if (result.stdout) callbacks.onLog?.(result.stdout.trim());

    return {
      status: 'success',
      outputPath,
      logs: result.stdout ? [result.stdout.trim()] : [],
    };
  } catch (error: unknown) {
    const err = error as { message: string; stderr?: string; stdout?: string };
    return {
      status: 'error',
      outputPath: inputPath,
      logs: err.stdout ? [err.stdout.trim()] : [],
      error: err.stderr || err.message,
    };
  }
}

export async function executeCommands(
  commands: { cmd: string; params: Record<string, unknown> }[],
  imagePath: string,
  callbacks: ExecutionCallbacks = {},
  tool: Tool = 'photocraft'
): Promise<ExecutionResult> {
  const logs: string[] = [];

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];

    const validationError = validateCommand(command.cmd, command.params, tool);
    if (validationError) {
      return { status: 'error', outputPath: imagePath, logs, error: validationError };
    }

    callbacks.onProgress?.({
      step: i + 1, total: commands.length,
      message: `正在执行: ${command.cmd}`,
      command: command.cmd, params: command.params,
    });

    const ext = imagePath.split('.').pop() || 'jpg';
    const outputPath = i < commands.length - 1
      ? imagePath.replace(/\.[^.]+$/, `_${i + 1}.${ext}`)
      : imagePath.replace(/\.[^.]+$/, `_result.${ext}`);

    const result = await executeCommand(command, imagePath, outputPath, {
      onLog: (log) => { logs.push(log); callbacks.onLog?.(log); },
    }, tool);

    if (result.status === 'error') {
      return { status: 'error', outputPath: imagePath, logs, error: `步骤 ${i + 1} 失败: ${result.error}` };
    }

    imagePath = result.outputPath;
  }

  return { status: 'success', outputPath: imagePath, logs };
}
