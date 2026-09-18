import test from 'node:test';
import assert from 'node:assert/strict';
import { searchClips, validateOptions } from '../src/client.js';

const clip = { id: 'clip-1', sourceId: 'film-1', sourceSlug: 'film', sourceTitle: 'City Traffic', sourceYear: 1956, startSeconds: 10, endSeconds: 15, durationSeconds: 5, videoUrl: 'https://example.com/clip.mp4', thumbnailUrl: '/poster.jpg', score: 0.25 };
const page = (clips = [clip], hasMore = false) => Response.json({ clips, hasMore, method: 'openclip' });

test('search sends observed API fields and preserves metadata and direct links', async () => {
  const result = await searchClips({ query: ' city traffic ', color: 'bw', yearMin: 1900, yearMax: 1960, aspectRatio: '4:3', offset: 4 }, { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://www.movingimagearchive.com/api/search');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { query: 'city traffic', color: 'black_and_white', aspectRatio: '4:3', offset: 4, yearMin: 1900, yearMax: 1960 });
    return page();
  }});
  assert.equal(result.clips[0].score, 0.25);
  assert.equal(result.clips[0].url, 'https://www.movingimagearchive.com/sources/film?clip=clip-1');
  assert.equal(result.clips[0].downloadUrl, 'https://www.movingimagearchive.com/api/clips/clip-1/download');
  assert.equal(result.nextOffset, null);
});

test('browse uses GET with encoded filters', async () => {
  await searchClips({ aspectRatio: '16:9' }, { fetchImpl: async (url, init) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/api/clips');
    assert.equal(u.searchParams.get('aspectRatio'), '16:9');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    return page();
  }});
});

test('truncated pages resume without skipping hidden rows', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...clip, id: `clip-${i}` }));
  const fetchImpl = async (_, init) => page(rows.slice(JSON.parse(init.body).offset));
  const first = await searchClips({ query: 'city', limit: 2 }, { fetchImpl });
  const second = await searchClips({ query: 'city', limit: 2, offset: first.nextOffset }, { fetchImpl });
  const third = await searchClips({ query: 'city', limit: 2, offset: second.nextOffset }, { fetchImpl });
  assert.deepEqual([...first.clips, ...second.clips, ...third.clips].map(c => c.id), rows.map(c => c.id));
  assert.equal(third.hasMore, false);
  assert.equal(third.nextOffset, null);
});

test('upstream page size can be smaller than requested limit', async () => {
  const result = await searchClips({ limit: 100, offset: 10 }, { fetchImpl: async () => page([clip], true) });
  assert.equal(result.count, 1);
  assert.equal(result.nextOffset, 11);
});

test('empty results are successful', async () => {
  const result = await searchClips({}, { fetchImpl: async () => page([]) });
  assert.equal(result.count, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextOffset, null);
});

test('invalid options fail before fetching', async () => {
  for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }, { timeout: 0 }, { query: ' ' }, { color: 'red' }, { aspectRatio: '9:16' }, { yearMin: 2000, yearMax: 1900 }]) {
    await assert.rejects(searchClips(options, { fetchImpl: () => assert.fail('must not fetch') }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(validateOptions({ color: 'bw' }).color, 'black_and_white');
});

test('rate limit exposes retry-after, with no retry', async () => {
  let calls = 0;
  await assert.rejects(searchClips({}, { fetchImpl: async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'retry-after': '60' } });
  }}), e => e.code === 'RATE_LIMITED' && e.details.retryAfter === '60');
  assert.equal(calls, 1);
});

test('HTTP and network errors are classified', async () => {
  await assert.rejects(searchClips({}, { fetchImpl: async () => new Response('', { status: 503 }) }), { code: 'HTTP_ERROR' });
  await assert.rejects(searchClips({}, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { code: 'NETWORK_ERROR' });
});

test('malformed responses fail clearly, including unsafe links and nonadvancing pages', async () => {
  for (const response of [() => new Response('<html>'), () => Response.json({}), () => page([], true), () => page([{ ...clip, id: null }]), () => page([{ ...clip, durationSeconds: -1 }]), () => page([{ ...clip, videoUrl: 'javascript:alert(1)' }])]) {
    await assert.rejects(searchClips({}, { fetchImpl: response }), { code: 'INVALID_RESPONSE' });
  }
});

test('timeout applies while consuming the body', async () => {
  // A real slow response body exercises native fetch cancellation.
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(searchClips({ timeout: 1 }, { fetchImpl: (_, init) => fetch(`http://127.0.0.1:${server.address().port}`, init) }), { code: 'TIMEOUT' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
