import { config as loadEnv } from 'dotenv';

// 用 .env 覆盖已在进程环境里存在的同名变量。
// 部署/启动环境（pm2、shell 脚本）可能注入了旧的 sensenova LLM_URL/MODEL，
// 默认 dotenv 不覆盖已存在的变量，会让 SiliconFlow patch 用错 URL 而 401。
loadEnv({ override: true });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKey: process.env.API_KEY || '',

  // LLM
  llmApiUrl: process.env.LLM_API_URL || 'https://token.sensenova.cn/v1',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'sensenova-6.8-flash-lite',

  // File storage
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  processedDir: process.env.PROCESSED_DIR || './processed',
  thumbnailDir: process.env.THUMBNAIL_DIR || './thumbnails',
  logDir: process.env.LOG_DIR || './logs',
  tempDir: process.env.TEMP_DIR || './temp',

  // CLI
  photocraftCli: process.env.PHOTOCRAFT_CLI || '/usr/local/bin/photocraft-cli',
  taskTimeout: parseInt(process.env.TASK_TIMEOUT || '60000', 10),

  // Harness agent（dsh headless --json）：把指令解析从单次 LLM 换成 headless agent
  harnessCli: process.env.HARNESS_CLI || '/usr/local/bin/dsh',
  harnessEnabled: process.env.HARNESS_ENABLED === 'true',

  // PhotoCraft `serve` gateway (real Rust photocraft-cli, JSON-RPC over loopback TCP)
  photocraftServePort: parseInt(process.env.PHOTOCRAFT_SERVE_PORT || '7878', 10),
  photocraftServeToken: process.env.PHOTOCRAFT_SERVE_TOKEN || '',
  photocraftServeRoot: process.env.PHOTOCRAFT_SERVE_ROOT || '.',
  photocraftServeBin: process.env.PHOTOCRAFT_SERVE_BIN || '/usr/local/bin/photocraft-cli',

  // Cleanup
  cleanupIntervalHours: 24,
  maxFileAgeDays: 7,
} as const;

export type Config = typeof config;
