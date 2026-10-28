import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { chat } from './api/chat.js';
import { upload } from './api/upload.js';
import { parse } from './api/parse.js';
import { createWebSocketServer } from './websocket/manager.js';
import { logger, initLogger } from './utils/logger.js';
import { initStorage, startCleanupScheduler, listImages } from './utils/file-manager.js';
import { healthCheck } from './utils/health.js';

async function main() {
  initLogger();
  logger.info('AI Agent Server starting...');

  // 初始化存储
  await initStorage();

  // 启动清理调度器
  startCleanupScheduler();

  const app = express();
  const server = http.createServer(app);

  // 中间件
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // 静态文件
  app.use('/uploads', express.static(path.resolve(config.uploadDir)));
  app.use('/processed', express.static(path.resolve(config.processedDir)));
  app.use('/thumbnails', express.static(path.resolve(config.thumbnailDir)));

  // 健康检查
  app.get('/api/health', (_req, res) => {
    res.json(healthCheck());
  });

  // API 路由（需要鉴权）
  app.use('/api/chat', authMiddleware, chat);
  app.use('/api/upload', authMiddleware, upload);
  app.use('/api/parse', authMiddleware, parse);

  // 图片列表（无需鉴权，用于前端展示）
  app.get('/api/images', async (_req, res) => {
    try {
      const images = await listImages();
      res.json({ images });
    } catch (error: unknown) {
      const err = error as Error;
      logger.error('List images failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 404 处理
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // 错误处理
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', err);
    res.status(500).json({ error: err.message });
  });

  // WebSocket
  createWebSocketServer(server);

  // 启动服务器
  server.listen(config.port, () => {
    logger.info(`AI Agent Server listening on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`LLM Model: ${config.llmModel}`);
    logger.info(`PhotoCraft CLI: ${config.photocraftCli}`);
  });

  // 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
