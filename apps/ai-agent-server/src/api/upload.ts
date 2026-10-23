import { Router, Request, Response } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { saveUploadFile, validateImageFile, listImages } from '../utils/file-manager.js';
import { logger } from '../utils/logger.js';

const upload = Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.tempDir);
  },
  filename: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop() || 'jpg';
    cb(null, `tmp_${Date.now()}.${ext}`);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (!validateImageFile(file.originalname)) {
    cb(new Error(`不支持的文件格式: ${file.originalname}`));
    return;
  }
  cb(null, true);
};

const uploadMiddleware = multer({
  storage,
  fileFilter,
});

/**
 * POST /api/upload - 上传图片
 */
upload.post('/', uploadMiddleware.single('image'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '没有提供文件' });
      return;
    }

    const filename = await saveUploadFile(req.file.originalname, req.file.path);

    res.json({
      success: true,
      filename,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (error: unknown) {
    const err = error as Error;
    logger.error('Upload failed', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/upload/list - 图片列表
 */
upload.get('/list', async (_req: Request, res: Response) => {
  try {
    const images = await listImages();
    res.json({ images });
  } catch (error: unknown) {
    const err = error as Error;
    logger.error('List images failed', err);
    res.status(500).json({ error: err.message });
  }
});

export { upload };
