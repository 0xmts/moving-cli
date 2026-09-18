import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { MovingError } from '../src/client.js';

const exec = args => spawnSync(process.execPath, ['bin/moving-cli.js', ...args], { encoding: 'utf8' });
async function invoke(args, search) {
  let out = '', err = '';
  const code = await run(args, { stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } }, search });
  return { code, out, err };
}

test('real executable provides help, version, and machine-readable discovery', () => {
  for (const args of [[], ['--help'], ['help']]) {
    const r = exec(args); assert.equal(r.status, 0); assert.match(r.stdout, /moving-cli search/); assert.equal(r.stderr, '');
  }
  assert.equal(exec(['--version']).stdout.trim(), '0.1.0');
  const schema = JSON.parse(exec(['schema']).stdout);
  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.options.limit.default, 10);
  assert.equal(schema.exitCodes[2], 'invalid arguments');
});

test('invalid command lines emit only structured stderr with status 2', () => {
  for (const args of [['bad'], ['search'], ['search', ''], ['search', 'one', 'two'], ['browse', 'extra'], ['browse', '--limit', '0'], ['browse', '--limit', '-1'], ['browse', '--limit', '2.5'], ['browse', '--limit', '1e2'], ['browse', '--offset', '9007199254740992'], ['browse', '--format', 'xml'], ['browse', '--pretty', '--format', 'text'], ['browse', '--unknown'], ['browse', '--color'], ['browse', '--limit', '1', '--limit', '2'], ['schema', '--color', 'bw'], ['browse', '--year-min', '2000', '--year-max', '1900']]) {
    const r = exec(args);
    assert.equal(r.status, 2, JSON.stringify(args)); assert.equal(r.stdout, '');
    assert.equal(JSON.parse(r.stderr).error.code, 'INVALID_ARGUMENT');
  }
});

test('valid search flags reach the client, JSON stays on stdout', async () => {
  const r = await invoke(['search', 'factory workers', '--color', 'bw', '--year-min', '1900', '--year-max', '1960', '--aspect-ratio', '4:3', '--limit', '3', '--offset', '5', '--timeout', '10', '--pretty'], async options => {
    assert.deepEqual(options, { query: 'factory workers', color: 'bw', yearMin: 1900, yearMax: 1960, aspectRatio: '4:3', limit: 3, offset: 5, timeout: 10 });
    return { schemaVersion: 1, clips: [] };
  });
  assert.equal(r.code, 0); assert.equal(r.err, ''); assert.match(r.out, /\n  "schemaVersion"/);
});

test('upstream failures have stable error JSON and exit 1', async () => {
  const r = await invoke(['browse'], async () => { throw new MovingError('RATE_LIMITED', 'Try later.', { status: 429, retryAfter: '60' }); });
  assert.equal(r.code, 1); assert.equal(r.out, '');
  assert.deepEqual(JSON.parse(r.err).error, { code: 'RATE_LIMITED', message: 'Try later.', status: 429, retryAfter: '60' });
});

test('text output escapes terminal controls and shows continuation', async () => {
  const r = await invoke(['browse', '--format', 'text'], async () => ({ offset: 0, hasMore: true, nextOffset: 1, clips: [{ sourceTitle: '\x1b[31mFilm\nTitle', sourceYear: null, durationSeconds: 4.321, startSeconds: 2, endSeconds: 6.321, url: 'https://example.com', colorMode: null, aspectRatio: '4:3' }] }));
  assert.equal(r.code, 0); assert.equal(r.err, ''); assert.doesNotMatch(r.out, /\x1b/);
  assert.match(r.out, /year unknown/); assert.match(r.out, /4.32s/); assert.match(r.out, /--offset 1/);
});
