import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { dispatch } from './api.js';
import { contentTypeFor } from './utils.js';
import { resolveUpload } from './storage.js';

export function buildServer() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    trustProxy: config.trustProxy,
    bodyLimit: config.maxBodyBytes
  });

  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (request, body, done) => {
    try { done(null, body ? JSON.parse(body) : {}); }
    catch (error) { done(error); }
  });

  app.get('/api', async () => ({ ok: true, message: 'Check-in API is running', stack: 'Fastify + SQLite', time: new Date().toISOString() }));
  app.get('/health', async () => ({ ok: true }));
  app.post('/api', async (request, reply) => {
    try {
      reply.header('cache-control', 'no-store');
      return await dispatch(request.body || {});
    } catch (error) {
      request.log.error(error);
      return { ok: false, error: process.env.NODE_ENV === 'production' ? 'server_error' : String(error.stack || error) };
    }
  });

  const sendHtml = (name) => async (_request, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache');
    return fs.createReadStream(path.join(config.rootDir, name));
  };
  app.get('/', sendHtml('index.html'));
  app.get('/index.html', sendHtml('index.html'));
  app.get('/admin', sendHtml('admin.html'));
  app.get('/admin.html', sendHtml('admin.html'));

  app.get('/files/:category/:name', async (request, reply) => {
    const target = resolveUpload(request.params.category, request.params.name);
    if (!target || !fs.existsSync(target)) return reply.code(404).send({ ok: false, error: 'file_not_found' });
    reply.type(contentTypeFor(target)).header('cache-control', 'private, max-age=86400');
    return fs.createReadStream(target);
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ ok: false, error: 'not_found' }));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const app = buildServer();
  const shutdown = async () => {
    try { await app.close(); } finally { db.close(); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
