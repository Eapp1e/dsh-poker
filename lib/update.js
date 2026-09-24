/**
 * "Is there a newer release?" - the one outward HTTP call the settings page makes.
 *
 * It asks the GitHub releases API for the repository in the settings, compares the tag
 * with the version this install is running, and turns the answer into plain lines the
 * settings page can print without knowing anything about GitHub. Every failure is a
 * sentence, never a throw: a machine without internet is the normal case, not an error
 * worth breaking a settings page over.
 * @module dsh-plugin-poker/update
 */

/** The repository this plugin lives in, used as the default. */
export const DEFAULT_REPO = 'Eapp1e/dsh-poker';

/** How long one answer is reused before asking GitHub again. */
const CACHE_MS = 10 * 60 * 1000;

/**
 * Parse a version tag into comparable numbers.
 *
 * Accepts `v1.2.3`, `1.2.3-beta.1` and anything else a tag might be: the numeric part
 * is used for comparison, and a tag that has none is compared as text.
 * @param value - a version string.
 * @returns `{ numbers, text }`.
 */
export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '');
  const numbers = (text.match(/\d+/g) || []).map((part) => Number(part));
  return { numbers, text };
}

/**
 * Compare two versions the way a person would read them.
 * @param a - the installed version.
 * @param b - the published one.
 * @returns -1, 0 or 1.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const one = left.numbers[index] ?? 0;
    const two = right.numbers[index] ?? 0;
    if (one !== two) return one < two ? -1 : 1;
  }
  if (left.numbers.length > 0 && right.numbers.length > 0) return 0;
  if (left.text === right.text) return 0;
  return left.text < right.text ? -1 : 1;
}

/** In-memory cache: one lookup per window, shared across requests. */
const cache = new Map();

/** The headers GitHub wants: a UA is mandatory, the accept pins the API version. */
function headers() {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-plugin-poker',
  };
}

/**
 * Ask GitHub for the newest release of a repository.
 *
 * Tries `/releases/latest` first (a published release), then falls back to `/tags`
 * (many repositories only tag), then reports the most useful sentence it can.
 * @param options - `{ repo, fetchImpl, timeoutMs, force }`.
 * @returns `{ ok, latest, url, notes, publishedAt, error? }`.
 */
export async function fetchLatestRelease(options = {}) {
  const repo = String(options.repo || DEFAULT_REPO).replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  const cached = cache.get(repo);
  if (!options.force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const doFetch = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 8000));
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  const remember = (value) => {
    cache.set(repo, { at: Date.now(), value });
    return value;
  };
  if (!doFetch) return { ok: false, error: '\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709 fetch' };

  const read = async (url) => {
    const response = await doFetch(url, { headers: headers(), signal });
    if (!response || response.ok !== true) return { status: response ? response.status : 0, json: null };
    return { status: response.status, json: await response.json() };
  };

  try {
    const release = await read(`https://api.github.com/repos/${repo}/releases/latest`);
    if (release.json && (release.json.tag_name || release.json.name)) {
      return remember({
        ok: true,
        source: 'release',
        latest: String(release.json.tag_name || release.json.name),
        url: String(release.json.html_url || `https://github.com/${repo}/releases`),
        notes: String(release.json.body || '').trim().slice(0, 600),
        publishedAt: release.json.published_at ? String(release.json.published_at) : null,
      });
    }
    if (release.status === 403) {
      return remember({ ok: false, error: 'GitHub \u9650\u6d41\u4e86\uff08\u672a\u767b\u5f55\u8bf7\u6c42\u6bcf\u5c0f\u65f6 60 \u6b21\uff09\uff0c\u7a0d\u540e\u518d\u8bd5' });
    }
    const tags = await read(`https://api.github.com/repos/${repo}/tags`);
    if (Array.isArray(tags.json) && tags.json.length > 0) {
      return remember({
        ok: true,
        source: 'tag',
        latest: String(tags.json[0].name),
        url: `https://github.com/${repo}/tags`,
        notes: '',
        publishedAt: null,
      });
    }
    if (tags.status === 404 || release.status === 404) {
      return remember({ ok: false, error: `\u6ca1\u627e\u5230\u4ed3\u5e93 ${repo}\uff08\u662f\u5426\u516c\u5f00\uff1f\uff09` });
    }
    return remember({ ok: false, error: '\u4ed3\u5e93\u8fd8\u6ca1\u6709\u53d1\u5e03\u8fc7\u7248\u672c\uff0c\u4e5f\u6ca1\u6709 tag' });
  } catch (error) {
    const name = error && error.name ? String(error.name) : '';
    const message = error && error.message ? String(error.message) : String(error);
    const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|abort/i.test(message);
    // A failed lookup is cached too, but only briefly: the next open retries.
    cache.set(repo, { at: Date.now() - CACHE_MS + 30000, value: { ok: false, error: timedOut ? `\u8d85\u65f6\uff08${timeoutMs}ms\uff09` : message.slice(0, 160) } });
    return { ok: false, error: timedOut ? `\u8d85\u65f6\uff08${timeoutMs}ms\uff09` : message.slice(0, 160) };
  }
}

/**
 * Turn a lookup into the lines the settings page shows.
 * @param options - `{ current, latest, fetch result }`.
 * @returns `{ ok, behind, current, latest, url, notes, lines }`.
 */
export function describeUpdate(options) {
  const current = String(options.current || '0.0.0');
  const found = options.found || {};
  if (found.ok !== true) {
    const raw = String(found.error || '\u67e5\u8be2\u5931\u8d25');
    // "fetch failed" is what a machine without GitHub access reports, and it says
    // nothing a player can act on: point at the release page instead.
    const reachable = /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(raw);
    const error = reachable ? '\u672c\u673a\u8bbf\u95ee\u4e0d\u5230 GitHub\uff08\u79bb\u7ebf\uff1f\uff09' : raw;
    return {
      ok: false,
      behind: false,
      current,
      latest: null,
      url: `https://github.com/${String(options.repo || DEFAULT_REPO)}/releases`,
      error,
      lines: [
        `\u5f53\u524d\u7248\u672c\uff1av${current}`,
        `\u26a0 \u65e0\u6cd5\u83b7\u53d6\u6700\u65b0\u7248\u672c\uff1a${error}`,
        '\u53ef\u4ee5\u76f4\u63a5\u6253\u5f00\u53d1\u5e03\u9875\u67e5\u770b\uff1b\u80fd\u8054\u7f51\u7684\u673a\u5668\u4e0a\u8fd9\u4e00\u6b65\u4f1a\u81ea\u52a8\u5b8c\u6210\u3002',
      ],
    };
  }
  const behind = compareVersions(current, found.latest) < 0;
  const lines = [`\u5f53\u524d\u7248\u672c\uff1av${current}\uff0c\u6700\u65b0\u7248\u672c\uff1av${String(found.latest).replace(/^v/i, '')}\u3002`];
  if (behind) {
    lines.push(`\u6709\u65b0\u7248\u672c\uff1a${found.source === 'tag' ? '\u4ed3\u5e93\u6709\u66f4\u65b0\u7684 tag' : '\u5df2\u53d1\u5e03\u65b0\u7248\u672c'}\u3002\u5347\u7ea7\uff1a`);
    lines.push('dsh plugin --profile web add dsh-plugin-poker@latest');
  } else {
    lines.push('\u5df2\u662f\u6700\u65b0\u7248\u672c\u3002');
  }
  return {
    ok: true,
    behind,
    current,
    latest: String(found.latest),
    url: found.url || `https://github.com/${String(options.repo || DEFAULT_REPO)}/releases`,
    notes: found.notes || '',
    publishedAt: found.publishedAt || null,
    source: found.source || 'release',
    lines,
  };
}

/**
 * The whole check: read the installed version, ask, describe.
 * @param options - `{ current, repo, fetchImpl, force }`.
 * @returns the object {@link describeUpdate} returns.
 */
export async function checkForUpdate(options = {}) {
  const repo = String(options.repo || DEFAULT_REPO);
  const found = await fetchLatestRelease({ repo, fetchImpl: options.fetchImpl, force: options.force });
  return describeUpdate({ current: options.current, repo, found });
}
