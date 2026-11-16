import http from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from './store.js';
import {HttpError} from './errors.js';
import {handleProtocol} from './protocol-routes.js';
import {stringify} from './precise-json.js';

export function configuration(env = process.env) {
  return {port: Number(env.PORT ?? 8088), host: env.HOST ?? '127.0.0.1', servicePrefix: env.SERVICE_PREFIX ?? '/local-development-key', dataDir: env.DATA_DIR, dataRoot: env.DATA_ROOT, maxBodyBytes: 16 * 1024 * 1024};
}

function normalizePrefix(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[?#\\\s]/.test(value)) throw new Error('SERVICE_PREFIX must be an absolute URL path without query or fragment');
  const path = value.replace(/\/+$/, '');
  if (!path || path.split('/').slice(1).some(segment => !segment || ['.', '..'].includes(segment))) throw new Error('SERVICE_PREFIX must contain a synthetic local key path');
  try {
    for (const segment of path.split('/').slice(1)) if (/[/%\\]/.test(decodeURIComponent(segment))) throw new Error();
  } catch { throw new Error('SERVICE_PREFIX has an invalid encoded segment'); }
  return path;
}

function readBody(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0;
    const cleanup = () => {
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', aborted);
    };
    const failed = () => { cleanup(); reject(new HttpError(400, 'Request body could not be read')); };
    const aborted = () => { cleanup(); reject(new HttpError(400, 'Request was interrupted')); };
    const data = chunk => {
      length += chunk.length;
      if (length > maximum) {
        cleanup(); request.resume();
        reject(new HttpError(413, 'Request body exceeds the local limit')); return;
      }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', aborted);
  });
}

/** Return an unbound HTTP server; every listen call is restricted to IPv4 loopback. */
export function createServer(options = {}) {
  const config = {...configuration(), ...options};
  if (config.host !== '127.0.0.1') throw new Error('LDA Local Find requires HOST=127.0.0.1');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  if (!Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes < 1) throw new Error('Body limit must be a positive integer');
  const prefix = normalizePrefix(config.servicePrefix);
  const store = new Store(config);
  const server = http.createServer({requestTimeout: 30000, headersTimeout: 15000}, async (request, response) => {
    function send(status, body, headers = {}) {
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
      response.end(stringify(body)); return true;
    }
    try {
      const authorities = new Set([`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`]);
      if (request.socket.localPort === 80) { authorities.add('127.0.0.1'); authorities.add('localhost'); }
      if (!authorities.has(request.headers.host?.toLowerCase())) throw new HttpError(403, 'Host is not allowed');
      if (request.headers.origin && ![...authorities].some(host => request.headers.origin === `http://${host}`)) throw new HttpError(403, 'Cross-origin requests are not supported');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(`${prefix}/`)) throw new HttpError(403, 'Service prefix is not accepted');
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Compressed request bodies are not supported');
      if (request.headers['content-length'] && Number(request.headers['content-length']) > config.maxBodyBytes) throw new HttpError(413, 'Request body exceeds the local limit');
      let segments;
      try { segments = url.pathname.slice(prefix.length + 1).replace(/\/$/, '').split('/').map(decodeURIComponent); }
      catch { throw new HttpError(400, 'Malformed encoded path'); }
      if (segments.some(segment => !segment)) throw new HttpError(404, 'Route is not available');
      const text = await readBody(request, config.maxBodyBytes);
      if (text && !/^application\/(?:json|x-ndjson)(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Use a JSON content type');
      return handleProtocol({store, method: request.method, segments, params: url.searchParams, text, send});
    } catch (error) {
      if (response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      // Never log URLs, headers or payloads: the service path may contain credentials.
      if (status === 500) (config.logger ?? console).error('LDA Local Find could not complete a request');
      return send(status, {error: status === 500 ? 'Local storage or request processing failed' : error.message, status}, status === 413 ? {Connection: 'close'} : {});
    }
  });
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    if (args[0] && typeof args[0] === 'object') {
      if (args[0].path || args[0].fd || args[0].host && args[0].host !== '127.0.0.1') throw new Error('Only 127.0.0.1 listening is supported');
      return listen({...args[0], host: '127.0.0.1'}, ...args.slice(1));
    }
    if (typeof args[0] !== 'number') throw new Error('Listen requires a numeric port');
    if (typeof args[1] === 'string' && args[1] !== '127.0.0.1') throw new Error('Only 127.0.0.1 listening is supported');
    if (typeof args[1] === 'string') return listen(...args);
    return listen(args[0], '127.0.0.1', ...args.slice(1));
  };
  server.store = store;
  server.config = config;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = createServer();
    server.on('error', () => { console.error('LDA Local Find could not start; check the port and local settings'); process.exitCode = 1; });
    server.listen(server.config.port, () => console.log(`LDA Local Find listening on http://127.0.0.1:${server.address().port}; service prefix omitted from logs`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { process.exitCode = 0; }));
  } catch { console.error('LDA Local Find could not start; check configuration and the local data store'); process.exitCode = 1; }
}
