import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { logger } from './logger.js';

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.heic', '.heif', '.bmp']);

/**
 * 生成唯一文件 ID
 */
export function generateFileId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}_${random}`;
}

/**
 * 验证图片文件
 */
export function validateImageFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * 初始化存储目录
 */
export async function initStorage(): Promise<void> {
  const dirs = [config.uploadDir, config.processedDir, config.thumbnailDir, config.tempDir];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      await fsp.mkdir(dir, { recursive: true });
      logger.info(`Created directory: ${dir}`);
    }
  }
}

/**
 * 保存上传的图片
 */
export async function saveUploadFile(originalName: string, filePath: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  if (!validateImageFile(originalName)) {
    throw new Error(`不支持的文件格式: ${ext}`);
  }

  const fileId = generateFileId();
  const newFilename = `${fileId}${ext}`;
  const destPath = path.join(config.uploadDir, newFilename);

  await fsp.copyFile(filePath, destPath);
  await fsp.unlink(filePath);

  logger.info(`File uploaded: ${newFilename}`);
  return newFilename;
}

/**
 * 获取图片路径
 */
export function getImagePath(filename: string): string {
  return path.join(config.uploadDir, filename);
}

/**
 * 获取处理后图片路径
 */
export function getProcessedPath(filename: string): string {
  return path.join(config.processedDir, filename);
}

/**
 * 列出所有图片
 */
export async function listImages(): Promise<{ filename: string; size: number; createdAt: string }[]> {
  try {
    const files = await fsp.readdir(config.uploadDir);
    const images: { filename: string; size: number; createdAt: string }[] = [];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) {
        const filePath = path.join(config.uploadDir, file);
        const stats = await fsp.stat(filePath);
        images.push({
          filename: file,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
        });
      }
    }

    return images.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch (error) {
    logger.error('Failed to list images', error);
    return [];
  }
}

/**
 * 清理过期文件
 */
export async function cleanupOldFiles(): Promise<void> {
  const cutoff = Date.now() - config.maxFileAgeDays * 24 * 60 * 60 * 1000;
  const dirs = [config.uploadDir, config.processedDir, config.tempDir];

  for (const dir of dirs) {
    try {
      const files = await fsp.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await fsp.stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await fsp.unlink(filePath);
          logger.info(`Cleaned up old file: ${file}`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to clean up directory: ${dir}`, error);
    }
  }
}

/**
 * 启动定期清理
 */
export function startCleanupScheduler(): void {
  const intervalMs = config.cleanupIntervalHours * 60 * 60 * 1000;
  setInterval(() => {
    logger.info('Starting cleanup...');
    cleanupOldFiles().catch((error) => {
      logger.error('Cleanup failed', error);
    });
  }, intervalMs);
  logger.info(`Cleanup scheduler started (every ${config.cleanupIntervalHours} hours)`);
}
