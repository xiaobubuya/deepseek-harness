/* ================================================================
   AI Agent 代理 — 自然语言图片编辑
   代理到 ai-agent-server (120.48.86.101:3000)
   ================================================================ */

const AGENT_BASE = process.env.AGENT_BASE_URL || 'http://120.48.86.101:3000';
const AGENT_KEY = process.env.AGENT_API_KEY || 'bubu';

export function routeAiAgent({ method, path, request, env, cors, session }) {
  const apiKey = env.AGENT_API_KEY || AGENT_KEY;

  // POST /api/ai-agent/chat
  if (path === '/api/ai-agent/chat' && method === 'POST') {
    return handleChat(request, apiKey);
  }

  // POST /api/ai-agent/upload
  if (path === '/api/ai-agent/upload' && method === 'POST') {
    return handleUpload(request, apiKey);
  }

  // GET /api/ai-agent/images
  if (path === '/api/ai-agent/images' && method === 'GET') {
    return handleImages(apiKey);
  }

  // GET /api/ai-agent/status/:taskId
  const statusMatch = path.match(/^\/api\/ai-agent\/status\/([^/]+)$/);
  if (statusMatch && method === 'GET') {
    return handleStatus(statusMatch[1], apiKey);
  }

  // GET /api/ai-agent/result/*
  const resultMatch = path.match(/^\/api\/ai-agent\/result\/(.+)$/);
  if (resultMatch && method === 'GET') {
    return handleResult(resultMatch[1], apiKey);
  }

  return null;
}

async function handleChat(request, apiKey) {
  try {
    const res = await fetch(`${AGENT_BASE}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(request.body),
    });
    return await res.json();
  } catch (err) {
    return { error: 'agent_unavailable', message: err.message };
  }
}

async function handleUpload(request, apiKey) {
  try {
    const formData = new FormData();
    if (request.body?.file) formData.append('file', request.body.file);
    if (request.body?.name) formData.append('name', request.body.name);

    const res = await fetch(`${AGENT_BASE}/api/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: formData,
    });
    return await res.json();
  } catch (err) {
    return { error: 'agent_unavailable', message: err.message };
  }
}

async function handleImages(apiKey) {
  try {
    const res = await fetch(`${AGENT_BASE}/api/images`, {
      headers: { 'X-API-Key': apiKey },
    });
    return await res.json();
  } catch (err) {
    return { error: 'agent_unavailable', message: err.message };
  }
}

async function handleStatus(taskId, apiKey) {
  try {
    const res = await fetch(`${AGENT_BASE}/api/chat/status/${taskId}`, {
      headers: { 'X-API-Key': apiKey },
    });
    return await res.json();
  } catch (err) {
    return { error: 'agent_unavailable', message: err.message };
  }
}

async function handleResult(p, apiKey) {
  try {
    const res = await fetch(`${AGENT_BASE}/${p}`, {
      headers: { 'X-API-Key': apiKey },
    });
    if (!res.ok) return { error: 'not_found' };

    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, data: buffer, contentType: res.headers.get('content-type') };
  } catch (err) {
    return { error: 'agent_unavailable', message: err.message };
  }
}
