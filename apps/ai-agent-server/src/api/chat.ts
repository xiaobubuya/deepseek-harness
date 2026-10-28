import { Router, Request, Response } from 'express';
import { config } from '../config.js';
import { parseInstruction } from '../core/llm-parser.js';
import { executeCommands, validateCommand } from '../core/cli-executor.js';
import { getImagePath } from '../utils/file-manager.js';
import { analyzeImage, analyzeImageBase64 } from '../core/vision-context.js';
import { logger } from '../utils/logger.js';
import { websocketManager } from '../websocket/manager.js';

const chat = Router();

/**
 * POST /api/chat - 接收用户指令
 */
chat.post('/', async (req: Request, res: Response) => {
  const { message, imageId, imageFilename, imageBase64, docSize } = req.body;

  if (!message) {
    res.status(400).json({ error: '缺少 message 字段' });
    return;
  }

  if (!imageId && !imageFilename) {
    res.status(400).json({ error: '缺少 imageId 或 imageFilename' });
    return;
  }

  const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const ws = websocketManager.getConnections().get(taskId);

  // 异步执行，立即返回 taskId
  (async () => {
    try {
      if (ws) {
        await ws.send(JSON.stringify({ type: 'ack', taskId }));
      }

      // 解析指令
      if (ws) {
        await ws.send(JSON.stringify({ type: 'thinking', thought: '正在分析您的指令...' }));
      }

      // 视觉分析：优先用前端带来的当前画布，其次用服务端已存的原图。
      // 失败时返回 null，解析链路退化为纯文字（行为与改造前一致）。
      let vision = null;
      if (typeof imageBase64 === 'string' && imageBase64.startsWith('data:image/')) {
        vision = await analyzeImageBase64(imageBase64);
      } else if (imageFilename) {
        vision = await analyzeImage(getImagePath(imageFilename));
      }
      if (vision) logger.info(`[Chat] 视觉摘要: 主体=${vision.subject.name}`);

      // 文档尺寸：前端上报优先；否则用视觉分析时读到的原图尺寸（chat 走 analyzeImage 时有效）。
      const doc = docSize && typeof docSize.w === 'number' && typeof docSize.h === 'number'
        ? { w: docSize.w, h: docSize.h }
        : vision && vision.size.w > 0
          ? { w: vision.size.w, h: vision.size.h }
          : undefined;

      const result = await parseInstruction(message, async (thought) => {
        if (ws) {
          await ws.send(JSON.stringify({ type: 'thinking', thought }));
        }
      }, { vision: vision ?? undefined, docSize: doc });

      if (ws) {
        await ws.send(
          JSON.stringify({
            type: 'command',
            command: result.commands.map((c) => c.cmd).join(', '),
            params: result.commands,
            explanation: result.explanation,
          })
        );
      }

      // 验证命令
      for (const cmd of result.commands) {
        const error = validateCommand(cmd.cmd, cmd.params);
        if (error) {
          if (ws) {
            await ws.send(JSON.stringify({ type: 'error', code: 'INVALID_COMMAND', message: error }));
          }
          return;
        }
      }

      // 执行命令
      const imagePath = imageFilename ? getImagePath(imageFilename) : getImagePath(imageId || '');

      const executionResult = await executeCommands(result.commands, imagePath, {
        onProgress: async (progress) => {
          if (ws) {
            await ws.send(JSON.stringify({ type: 'progress', ...progress }));
          }
        },
        onLog: async (log) => {
          if (ws) {
            await ws.send(JSON.stringify({ type: 'log', level: 'info', message: log }));
          }
        },
      });

      if (executionResult.status === 'success') {
        if (ws) {
          await ws.send(
            JSON.stringify({
              type: 'done',
              resultUrl: `/processed/${executionResult.outputPath.split('/').pop()}`,
              commands: result.commands.map((c) => c.cmd),
              explanation: result.explanation,
            })
          );
        }
        logger.info(`Task ${taskId} completed successfully`);
      } else {
        if (ws) {
          await ws.send(
            JSON.stringify({ type: 'error', code: 'EXECUTION_ERROR', message: executionResult.error })
          );
        }
        logger.error(`Task ${taskId} failed: ${executionResult.error}`);
      }
    } catch (error: unknown) {
      const err = error as Error;
      if (ws) {
        await ws.send(JSON.stringify({ type: 'error', code: 'INTERNAL_ERROR', message: err.message }));
      }
      logger.error(`Task ${taskId} error: ${err.message}`, err);
    }
  })();

  res.json({ taskId, status: 'accepted' });
});

/**
 * GET /api/chat/status/:taskId - 查询任务状态
 */
chat.get('/status/:taskId', (req: Request, res: Response) => {
  const { taskId } = req.params;
  res.json({ taskId, status: 'running' });
});

export { chat };
