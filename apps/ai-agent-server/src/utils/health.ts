import { logger } from './logger.js';
import { config } from '../config.js';

/**
 * 验证 API Key
 */
export function validateApiKey(key: string): boolean {
  if (!config.apiKey) return true;
  return key === config.apiKey;
}

/**
 * 健康检查
 */
export function healthCheck(): {
  status: string;
  uptime: number;
  memory: { used: number; total: number };
} {
  const memory = process.memoryUsage();
  return {
    status: 'ok',
    uptime: process.uptime(),
    memory: {
      used: Math.round(memory.heapUsed / 1024 / 1024),
      total: Math.round(memory.heapTotal / 1024 / 1024),
    },
  };
}
