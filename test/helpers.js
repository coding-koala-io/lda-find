import assert from 'node:assert/strict';
import {createServer} from '../src/server.js';

export const PREFIX = '/tenant/synthetic-development-key';
export const quiet = {error() {}};

export async function gateway(t, options = {}) {
  const server = createServer({port: 0, host: '127.0.0.1', servicePrefix: `${PREFIX}/`, dataDir: ':memory:', logger: quiet, ...options});
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, {method = 'GET', body, headers = {}, prefixed = true} = {}) {
    const response = await fetch(`${base}${prefixed ? PREFIX : ''}${path}`, {
      method,
      headers: {...(body !== undefined ? {'Content-Type': 'application/json; charset=utf-8'} : {}), ...headers},
      ...(body !== undefined ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {}),
    });
    const text = await response.text();
    return {status: response.status, data: JSON.parse(text), text, headers: response.headers};
  }
  async function put(id, source, {index = 'pages', type = 'Synthetic_ArticlePage', ...options} = {}) {
    const result = await request(`/${index}/${type}/${encodeURIComponent(id)}`, {method: 'PUT', body: source, ...options});
    assert.ok([200, 201].includes(result.status), JSON.stringify(result.data));
    return result;
  }
  async function search(body = {}, path = '/pages/_search') {
    const result = await request(path, {method: 'POST', body});
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  return {server, base, request, put, search};
}

export const ndjson = (...records) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
export const ids = result => result.hits.hits.map(hit => hit._id);
export function envelope(result) {
  assert.equal(typeof result.took, 'number');
  assert.equal(result.timed_out, false);
  assert.deepEqual(result._shards, {total: 1, successful: 1, failed: 0});
  assert.equal(Number.isInteger(result.hits.total), true);
  assert.equal(Array.isArray(result.hits.hits), true);
  for (const hit of result.hits.hits) for (const name of ['_index', '_type', '_id']) assert.equal(typeof hit[name], 'string');
}
