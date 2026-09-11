import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictError, createStore, NotFoundError, ValidationError } from './store.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(rootDir, 'app');
const port = Number(process.env.STORYBOARD_PORT || 43127);
const store = createStore({ rootDir });
const logDir = join(rootDir, 'data', 'logs');
const logFile = join(logDir, 'storyboard-review.jsonl');

async function logEvent(event, details = {}) {
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, 'utf8');
  } catch {}
}

async function recentLogs(limit = 300) {
  const text = await readFile(logFile, 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter(Boolean).slice(-Math.min(Math.max(Number(limit) || 300, 1), 1000)).map((line) => {
    try { return JSON.parse(line); } catch { return { event: 'invalid_log_line' }; }
  });
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 70 * 1024 * 1024) throw new ValidationError('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationError('JSON 格式错误'); }
}

function checkOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function serveFile(response, path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(path).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': path.includes(`${join('data', '')}`) ? 'no-store' : 'no-cache',
  });
  createReadStream(path).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    if (!checkOrigin(request)) return sendJson(response, 403, { error: '拒绝跨站请求' });
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const path = decodeURIComponent(url.pathname);

    if (request.method === 'GET' && path === '/api/health') {
      return sendJson(response, 200, { ok: true, version: '0.1.10' });
    }
    if (request.method === 'GET' && path === '/api/logs') {
      return sendJson(response, 200, { logs: await recentLogs(url.searchParams.get('limit')) });
    }
    if (request.method === 'GET' && path === '/api/bootstrap') {
      const state = await store.readState();
      const empty = !state.shots.length && !state.batches.length && !state.assets.length;
      return sendJson(response, 200, { state, empty });
    }
    if (request.method === 'PUT' && path === '/api/project') {
      const body = await readJson(request);
      const state = await store.replaceProject(body.state, body.baseRevision);
      return sendJson(response, 200, { state });
    }
    if (request.method === 'GET' && path === '/api/export/final') {
      const result = await store.exportFinalScript();
      await logEvent('final_script_exported', { shotCount: result.shots.length, renumbered: result.renumbered });
      return sendJson(response, 200, result);
    }
    if (request.method === 'POST' && path === '/api/migrations/local-storage') {
      const body = await readJson(request);
      return sendJson(response, 200, await store.migrateLegacy(body.state));
    }
    const createRun = path.match(/^\/api\/batches\/([^/]+)\/runs$/);
    if (request.method === 'POST' && createRun) {
      const body = await readJson(request);
      const result = await store.createRun(createRun[1], body.mode);
      await logEvent('run_created', { runId: result.run.id, batchId: result.run.batchId, mode: result.run.mode, shotNos: result.run.sourceShotNos, assetCount: result.run.assetIds?.length || 0 });
      return sendJson(response, 201, result);
    }
    const deleteBatch = path.match(/^\/api\/batches\/([^/]+)$/);
    if (request.method === 'DELETE' && deleteBatch) {
      const result = await store.deleteLatestBatch(deleteBatch[1]);
      await logEvent('batch_deleted', result.deleted);
      return sendJson(response, 200, result);
    }
    const validateAssets = path.match(/^\/api\/batches\/([^/]+)\/assets\/validate$/);
    if (request.method === 'POST' && validateAssets) {
      return sendJson(response, 200, await store.validateBatchAssets(validateAssets[1]));
    }
    const getRun = path.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === 'GET' && getRun) {
      return sendJson(response, 200, { run: await store.runById(getRun[1]) });
    }
    if (request.method === 'POST' && path === '/api/mcp/context') {
      const body = await readJson(request);
      const context = await store.contextForToken(body.token);
      await logEvent('context_read', { runId: context.runId, batchId: context.batchId, mode: context.mode, shotCount: context.shots.length, assetCount: context.assets.length });
      return sendJson(response, 200, { context });
    }
    if (request.method === 'POST' && path === '/api/mcp/status') {
      const body = await readJson(request);
      const run = await store.updateRunStatus(body.token, body.status, body.message);
      await logEvent('run_status', { runId: run.id, batchId: run.batchId, status: run.status, message: run.message || '' });
      return sendJson(response, 200, { run });
    }
    if (request.method === 'POST' && path === '/api/mcp/revision-script') {
      const body = await readJson(request);
      const result = await store.prepareRevisionScript(body.token, body.scriptText);
      const context = await store.contextForToken(body.token);
      await logEvent('revision_prepared', { runId: context.runId, batchId: context.batchId, shotCount: context.shots.length });
      return sendJson(response, 200, result);
    }
    if (request.method === 'POST' && path === '/api/mcp/submit') {
      const body = await readJson(request);
      const result = await store.submitVersion(body);
      await logEvent('version_submitted', { runId: result.run?.id || '', batchId: result.run?.batchId || '', versionId: result.version?.id || result.versionId, duplicate: Boolean(result.duplicate) });
      return sendJson(response, 201, result);
    }
    if (request.method === 'GET' && path.startsWith('/files/')) {
      const target = store.resolvePublicFile(path);
      if (target && await serveFile(response, target)) return;
      return sendJson(response, 404, { error: '文件不存在' });
    }
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      if (await serveFile(response, join(appDir, 'index.html'))) return;
    }
    return sendJson(response, 404, { error: '接口不存在' });
  } catch (error) {
    const statusCode = error instanceof ConflictError ? 409
      : error instanceof NotFoundError ? 404
      : error instanceof ValidationError ? 400
      : 500;
    if (statusCode === 500) console.error(error);
    await logEvent('request_failed', { method: request.method, path: request.url?.split('?')[0] || '', statusCode, error: error.message || '服务器错误' });
    return sendJson(response, statusCode, {
      error: error.message || '服务器错误',
      ...(Array.isArray(error.issues) && error.issues.length ? { issues: error.issues } : {}),
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`分镜审核台已启动：http://127.0.0.1:${port}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
