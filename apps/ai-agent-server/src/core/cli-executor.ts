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

/**
 * 命令白名单
 */
const ALLOWED_COMMANDS = new Set([
  'color.temperature',
  'color.saturation',
  'color.brightness',
  'color.contrast',
  'color.hue',
  'color.exposure',
  'filter.warm',
  'filter.cool',
  'filter.blackwhite',
  'filter.sepia',
  'filter.vintage',
  'sharpen',
  'denoise',
  'blur',
  'vignette',
  'grain',
  'resize',
  'crop',
  'rotate',
  'flip',
]);

/**
 * 验证命令
 */
export function validateCommand(cmd: string, params: Record<string, unknown>): string | null {
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return `不支持的命令: ${cmd}`;
  }

  // 检查危险字符
  const jsonString = JSON.stringify(params);
  const dangerousChars = [';', '|', '&', '$', '`', '\n', '\r'];
  for (const char of dangerousChars) {
    if (jsonString.includes(char)) {
      return `参数包含危险字符: ${char}`;
    }
  }

  return null;
}

/**
 * 构建 CLI 参数
 */
function buildCLIArgs(
  command: { cmd: string; params: Record<string, unknown> },
  inputPath: string,
  outputPath: string
): string[] {
  return [
    'run',
    inputPath,
    '--cmd',
    command.cmd,
    '--params',
    JSON.stringify(command.params),
    '--out',
    outputPath,
  ];
}

/**
 * 执行单个命令
 */
async function executeCommand(
  command: { cmd: string; params: Record<string, unknown> },
  inputPath: string,
  outputPath: string,
  callbacks: ExecutionCallbacks
): Promise<ExecutionResult> {
  const args = buildCLIArgs(command, inputPath, outputPath);

  try {
    const result = await Promise.race([
      execFileAsync(config.photocraftCli, args, { timeout: config.taskTimeout }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`命令超时 (${config.taskTimeout}ms)`)), config.taskTimeout)
      ),
    ]);

    if (result.stdout) {
      callbacks.onLog?.(result.stdout.trim());
    }

    return {
      status: 'success',
      outputPath,
      logs: result.stdout ? [result.stdout.trim()] : [],
    };
  } catch (error: unknown) {
    const err = error as { message: string; stderr?: string; stdout?: string };
    const errorMessage = err.stderr || err.message;

    return {
      status: 'error',
      outputPath: inputPath,
      logs: err.stdout ? [err.stdout.trim()] : [],
      error: errorMessage,
    };
  }
}

/**
 * 执行命令序列
 */
export async function executeCommands(
  commands: { cmd: string; params: Record<string, unknown> }[],
  imagePath: string,
  callbacks: ExecutionCallbacks = {}
): Promise<ExecutionResult> {
  const logs: string[] = [];

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];

    // 验证命令
    const validationError = validateCommand(command.cmd, command.params);
    if (validationError) {
      return {
        status: 'error',
        outputPath: imagePath,
        logs,
        error: validationError,
      };
    }

    // 发送进度
    callbacks.onProgress?.({
      step: i + 1,
      total: commands.length,
      message: `正在执行: ${command.cmd}`,
      command: command.cmd,
      params: command.params,
    });

    // 构建输出路径
    const ext = imagePath.split('.').pop() || 'jpg';
    const outputPath =
      i < commands.length - 1
        ? imagePath.replace(/\.[^.]+$/, `_${i + 1}.${ext}`)
        : imagePath.replace(/\.[^.]+$/, `_result.${ext}`);

    // 执行命令
    const result = await executeCommand(command, imagePath, outputPath, {
      onLog: (log) => {
        logs.push(log);
        callbacks.onLog?.(log);
      },
    });

    if (result.status === 'error') {
      return {
        status: 'error',
        outputPath: imagePath,
        logs,
        error: `步骤 ${i + 1} 失败: ${result.error}`,
      };
    }

    // 更新输入路径为输出路径
    imagePath = result.outputPath;
  }

  return {
    status: 'success',
    outputPath: imagePath,
    logs,
  };
}
