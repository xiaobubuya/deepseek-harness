import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

/**
 * API Key 鉴权中间件
 * 检查 X-API-Key 请求头
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'] as string | undefined;

  if (!config.apiKey) {
    // 如果未配置 API_KEY，跳过鉴权（开发模式）
    next();
    return;
  }

  if (key !== config.apiKey) {
    res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    return;
  }

  next();
}

/**
 * 验证 API Key（用于 WebSocket）
 */
export function validateApiKey(key: string): boolean {
  if (!config.apiKey) return true;
  return key === config.apiKey;
}
