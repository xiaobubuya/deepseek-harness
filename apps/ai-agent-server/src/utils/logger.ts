import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_DIR = config.logDir;
let logStream: fs.WriteStream | null = null;

/**
 * 初始化日志目录
 */
export function initLogger(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const date = new Date().toISOString().split('T')[0];
  const logFile = path.join(LOG_DIR, `${date}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
}

/**
 * 写入日志
 */
export function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const entry = JSON.stringify({ timestamp, level, message, data });

  // 控制台输出
  if (level === 'error') {
    console.error(`[${timestamp}] ${entry}`);
  } else if (level === 'warn') {
    console.warn(`[${timestamp}] ${entry}`);
  } else {
    console.log(`[${timestamp}] ${entry}`);
  }

  // 文件输出
  if (logStream) {
    logStream.write(entry + '\n');
  }
}

export const logger = {
  info: (message: string, data?: unknown) => log('info', message, data),
  warn: (message: string, data?: unknown) => log('warn', message, data),
  error: (message: string, data?: unknown) => log('error', message, data),
  debug: (message: string, data?: unknown) => log('debug', message, data),
};
