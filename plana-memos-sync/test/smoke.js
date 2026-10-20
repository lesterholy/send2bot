import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { syncMemos } from '../src/sync.js';

const memo = {
  name: 'memos/101',
  uid: '101',
  createTime: '2026-06-18T01:02:03Z',
  updateTime: '2026-06-18T01:02:04Z',
  content: [
    '#plana/tweet',
    '',
    '[Open tweet](https://x.com/test/status/1234567890)',
    '',
    '```json',
    JSON.stringify({
      tweet_id: '1234567890',
      raw_json: { rest_id: '1234567890', legacy: { full_text: 'hello' } },
      source_url: 'https://x.com/test/status/1234567890',
      captured_at: '2026-06-18T01:02:03Z',
      client_version: 'extension/test',
    }, null, 2),
    '```',
  ].join('\n'),
};

const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url });
  response.setHeader('Content-Type', 'application/json');

  if (request.method === 'GET' && request.url.startsWith('/api/v1/memos')) {
    response.end(JSON.stringify({ memos: [memo] }));
    return;
  }

  if (request.method === 'PATCH' && request.url.startsWith('/api/v1/memos/101')) {
    response.end(JSON.stringify({ ...memo, state: 'ARCHIVED' }));
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ message: 'not found' }));
});

const baseUrl = await listen(server);
const vault = await mkdtemp(path.join(tmpdir(), 'plana-memos-sync-'));

try {
  const dryRun = await syncMemos({
    apiUrl: `${baseUrl}/api/v1`,
    token: 'test-token',
    vault,
    archiveAfterSync: true,
    dryRun: true,
  });
  assert.equal(dryRun.written, 1);
  assert.equal(dryRun.archived, 0);
  assert.equal(requests.some((item) => item.method === 'PATCH'), false);

  const first = await syncMemos({
    apiUrl: `${baseUrl}/api/v1`,
    token: 'test-token',
    vault,
    archiveAfterSync: true,
  });
  assert.equal(first.scanned, 1);
  assert.equal(first.matched, 1);
  assert.equal(first.written, 1);
  assert.equal(first.archived, 1);
  assert.equal(first.failed, 0);

  const note = await readFile(path.join(vault, 'PlanA', '2026-06-18', 'tweet-1234567890.md'), 'utf8');
  assert.match(note, /tweet_id: "1234567890"/);
  assert.match(note, /#plana\/tweet/);

  const raw = await readFile(path.join(vault, 'PlanA', 'raw', '2026-06-18', 'tweet-1234567890.json'), 'utf8');
  assert.equal(JSON.parse(raw).tweet_id, '1234567890');

  const second = await syncMemos({
    apiUrl: `${baseUrl}/api/v1`,
    token: 'test-token',
    vault,
    archiveAfterSync: true,
  });
  assert.equal(second.written, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.archived, 0);

  assert.equal(requests.some((item) => item.method === 'PATCH'), true);
} finally {
  server.close();
  await rm(vault, { recursive: true, force: true });
}

function listen(httpServer) {
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
