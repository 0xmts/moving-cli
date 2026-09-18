export const ORIGIN = 'https://www.movingimagearchive.com';
export const COLORS = ['all', 'color', 'black_and_white'];
export const ASPECT_RATIOS = ['all', '4:3', '3:2', '16:9'];

export class MovingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MovingError';
    this.code = code;
    this.details = details;
  }
}

export function validateOptions(input = {}) {
  const o = { query: null, color: 'all', aspectRatio: 'all', limit: 10, offset: 0, timeout: 30, ...input };
  if (o.query !== null && (typeof o.query !== 'string' || !o.query.trim())) {
    throw new MovingError('INVALID_ARGUMENT', 'Search query must not be empty.');
  }
  if (o.query !== null) o.query = o.query.trim();
  if (o.color === 'bw') o.color = 'black_and_white';
  for (const [key, choices] of [['color', COLORS], ['aspectRatio', ASPECT_RATIOS]]) {
    if (!choices.includes(o[key])) throw new MovingError('INVALID_ARGUMENT', `${key} must be one of: ${choices.join(', ')}.`);
  }
  for (const [key, min, max] of [['limit', 1, 100], ['offset', 0, Number.MAX_SAFE_INTEGER - 100], ['timeout', 1, 120], ['yearMin', 1, 9999], ['yearMax', 1, 9999]]) {
    if (o[key] !== undefined && (!Number.isSafeInteger(o[key]) || o[key] < min || o[key] > max)) {
      throw new MovingError('INVALID_ARGUMENT', `${key} must be an integer between ${min} and ${max}.`);
    }
  }
  if (o.yearMin > o.yearMax) throw new MovingError('INVALID_ARGUMENT', 'yearMin must not exceed yearMax.');
  return o;
}

function schemaError() {
  return new MovingError('INVALID_RESPONSE', 'The archive returned an unexpected response; its public API may have changed.');
}

function httpUrl(value) {
  if (typeof value !== 'string') throw schemaError();
  try {
    const url = new URL(value, ORIGIN);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw schemaError();
    return url.href;
  } catch { throw schemaError(); }
}

function normalizeClip(c) {
  if (!c || typeof c !== 'object') throw schemaError();
  for (const k of ['id', 'sourceId', 'sourceSlug', 'sourceTitle']) {
    if (typeof c[k] !== 'string' || !c[k]) throw schemaError();
  }
  for (const k of ['startSeconds', 'endSeconds', 'durationSeconds']) {
    if (!Number.isFinite(c[k]) || c[k] < 0) throw schemaError();
  }
  if (c.endSeconds < c.startSeconds) throw schemaError();
  if (c.sourceYear != null && !Number.isInteger(c.sourceYear)) throw schemaError();
  for (const k of ['score', 'matchTimestampSeconds', 'position']) {
    if (c[k] != null && !Number.isFinite(c[k])) throw schemaError();
  }
  for (const k of ['colorMode', 'aspectRatio']) {
    if (c[k] != null && typeof c[k] !== 'string') throw schemaError();
  }
  const clip = {};
  for (const k of ['id', 'sourceId', 'sourceSlug', 'sourceTitle', 'sourceYear', 'position', 'startSeconds', 'endSeconds', 'durationSeconds', 'colorMode', 'aspectRatio', 'matchTimestampSeconds', 'score']) {
    clip[k] = c[k] ?? null;
  }
  clip.videoUrl = httpUrl(c.videoUrl);
  clip.thumbnailUrl = c.thumbnailUrl == null ? null : httpUrl(c.thumbnailUrl);
  clip.url = `${ORIGIN}/sources/${encodeURIComponent(c.sourceSlug)}?clip=${encodeURIComponent(c.id)}`;
  clip.downloadUrl = `${ORIGIN}/api/clips/${encodeURIComponent(c.id)}/download`;
  return clip;
}

/** One upstream page only. Truncated rows remain reachable via nextOffset. */
export async function searchClips(input = {}, { fetchImpl = globalThis.fetch } = {}) {
  const o = validateOptions(input);
  const filters = { color: o.color, aspectRatio: o.aspectRatio, yearMin: o.yearMin ?? null, yearMax: o.yearMax ?? null };
  const params = { color: o.color, aspectRatio: o.aspectRatio, offset: o.offset };
  if (o.yearMin !== undefined) params.yearMin = o.yearMin;
  if (o.yearMax !== undefined) params.yearMax = o.yearMax;
  const url = o.query === null ? `${ORIGIN}/api/clips?${new URLSearchParams(params)}` : `${ORIGIN}/api/search`;
  const signal = AbortSignal.timeout(o.timeout * 1000);
  try {
    const response = await fetchImpl(url, {
      method: o.query === null ? 'GET' : 'POST',
      headers: { Accept: 'application/json', 'User-Agent': 'moving-cli/0.1.0', ...(o.query === null ? {} : { 'Content-Type': 'application/json' }) },
      ...(o.query === null ? {} : { body: JSON.stringify({ query: o.query, ...params }) }),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      throw new MovingError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', `Archive request failed (HTTP ${response.status}).`, {
        status: response.status, ...(retryAfter ? { retryAfter } : {}),
      });
    }
    let data;
    try { data = await response.json(); } catch (e) {
      if (signal.aborted) throw e;
      throw schemaError();
    }
    if (!data || !Array.isArray(data.clips) || typeof data.hasMore !== 'boolean' || (data.method != null && typeof data.method !== 'string')) throw schemaError();
    // Empty pages with hasMore cannot produce a usable continuation.
    if (data.clips.length === 0 && data.hasMore) throw schemaError();
    const clips = data.clips.slice(0, o.limit).map(normalizeClip);
    const hasMore = data.hasMore || data.clips.length > clips.length;
    return {
      schemaVersion: 1, query: o.query, filters, method: data.method ?? null,
      offset: o.offset, limit: o.limit, count: clips.length, hasMore,
      nextOffset: hasMore ? o.offset + clips.length : null, clips,
    };
  } catch (e) {
    if (signal.aborted || e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new MovingError('TIMEOUT', `Archive request exceeded ${o.timeout} seconds.`);
    }
    if (e instanceof MovingError) throw e;
    throw new MovingError('NETWORK_ERROR', 'Could not reach the archive. Check your connection and try again.');
  }
}
