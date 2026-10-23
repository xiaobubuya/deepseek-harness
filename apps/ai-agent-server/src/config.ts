import 'dotenv/config';

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

  // Cleanup
  cleanupIntervalHours: 24,
  maxFileAgeDays: 7,
} as const;

export type Config = typeof config;
