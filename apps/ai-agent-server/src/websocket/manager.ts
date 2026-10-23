import { WebSocketServer, WebSocket } from 'ws';
import { validateApiKey } from '../auth.js';
import { logger } from '../utils/logger.js';

const clients = new Map<string, WebSocket>();

/**
 * 创建 WebSocket 服务器
 */
export function createWebSocketServer(httpServer: import('http').Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: import('http').IncomingMessage) => {
    const url = new URL(req.url || '', 'http://localhost');
    const apiKey = url.searchParams.get('key') || '';

    if (!validateApiKey(apiKey)) {
      ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Invalid API Key' }));
      ws.close();
      return;
    }

    const clientId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    clients.set(clientId, ws);

    logger.info(`WebSocket connected: ${clientId}`);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(ws, message);
      } catch (error: unknown) {
        const err = error as Error;
        logger.error('WebSocket message error', err);
        ws.send(JSON.stringify({ type: 'error', code: 'PARSE_ERROR', message: err.message }));
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      logger.info(`WebSocket disconnected: ${clientId}`);
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error', error);
    });
  });

  return wss;
}

/**
 * 处理客户端消息
 */
async function handleMessage(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
  const type = message.type as string;

  switch (type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'chat':
      // 转发到聊天处理器
      const { message: userMessage, imageId, imageFilename } = message;
      const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      ws.send(JSON.stringify({ type: 'ack', taskId }));

      // 这里应该调用聊天处理器
      // 暂时简单处理
      ws.send(
        JSON.stringify({
          type: 'thinking',
          thought: `收到指令: ${userMessage}, 图片: ${imageId || imageFilename}`,
        })
      );
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', code: 'UNKNOWN_TYPE', message: `Unknown message type: ${type}` }));
  }
}

/**
 * 获取所有连接
 */
export function getConnections(): Map<string, WebSocket> {
  return clients;
}

/**
 * 发送消息到特定客户端
 */
export async function sendToClient(clientId: string, message: unknown): Promise<void> {
  const ws = clients.get(clientId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * 广播消息到所有客户端
 */
export async function broadcast(message: unknown): Promise<void> {
  const json = JSON.stringify(message);
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}
