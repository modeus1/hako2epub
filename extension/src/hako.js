// Network + parsing layer: mirrors the desktop hako2epub downloader, using the
// browser's fetch (which carries the user's cookies) instead of cloudscraper /
// Playwright. Protected chapter content is decoded locally, so no headless
// browser is needed.

import {
  cleanText, parseHtml, safeXhtml, wrapFragment, escapeXml,
} from './dom.js';
import { buildEpub } from './epub.js';
import { chapterCache } from './cache.js';

const DOMAINS = ['ln.hako.vn', 'docln.net', 'docln.sbs'];
export const TOOL_VERSION = '2.7.0';

export const MODES = {
  // `requestDelay` is a global per-host cadence (shared by every worker), so
  // the effective interval is about 1.2x the value because of jitter.
  // Measured against docln.sbs: ~16 requests pass, then 429 with Retry-After:
  // 10s; sustained is ~1.5-2 requests/second. Fast leans on 429 back-off,
  // slow stays under the limit.
  fast: {
    label: 'Fast',
    threadNum: 6,
    requestDelay: 250,
    imageDelay: 150,
    timeout: 15000,
  },
  slow: {
    label: 'Slow',
    threadNum: 2,
    requestDelay: 500,
    imageDelay: 250,
    timeout: 60000,
  },
};

export class HakoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HakoError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

const IMAGE_MIME_EXTENSION = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/* ------------------------------------------------------------------ */
/* URL + filename helpers                                              */
/* ------------------------------------------------------------------ */

/** Validate user input and return a canonical novel URL. */
export function normalizePageUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new HakoError('Enter a light novel URL first.');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HakoError('That does not look like a valid URL.');
  }
  const host = url.hostname.replace(/^www\./, '');
  if (!DOMAINS.includes(host)) {
    throw new HakoError(`Unsupported site "${host}". Use one of: ${DOMAINS.join(', ')}.`);
  }
  url.hash = '';
  return url.toString();
}

/** Compare two novel/volume URLs ignoring the rotating domain. */
export function samePath(left, right) {
  const pathOf = (value) => {
    try {
      const url = new URL(value);
      return `${url.pathname}${url.search}`;
    } catch {
      return String(value || '');
    }
  };
  return pathOf(left) === pathOf(right);
}

/** Mirror of the desktop tool's TextUtils.format_filename(). */
export function formatFilename(name) {
  let value = String(name || '');
  for (const character of ['?', '!', '.', ':', '\\', '/', '<', '>', '|', '*', '"', ',']) {
    value = value.split(character).join('');
  }
  value = value.split(' ').join('-');
  return value.slice(0, 100);
}

export function novelFolder(novelName) {
  return formatFilename(novelName);
}

export function epubFilename(volumeName, novelName) {
  return `${formatFilename(`${volumeName}-${novelName}`)}.epub`;
}

/** Resolve a possibly relative href against the page it was found on. */
export function absoluteUrl(href, baseUrl) {
  if (!href) return '';
  try {
    const url = new URL(href, baseUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Content decoding                                                    */
/* ------------------------------------------------------------------ */

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function unescapeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x?([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(
      /^[0-9]+$/.test(code) ? parseInt(code, 10) : parseInt(code, 16),
    ))
    .replace(/&amp;/g, '&');
}

/**
 * Decode the docln/hako "xor_shuffle" protected payload: a JSON array of
 * (4-digit sort key + base64 chunk) strings, XOR-ed with a per-chapter key.
 */
export function xorShuffleDecode(encodedParts, key) {
  if (!encodedParts || !key) return '';
  let parts;
  try {
    parts = JSON.parse(unescapeEntities(encodedParts));
  } catch {
    return '';
  }
  if (!Array.isArray(parts)) return '';
  const keyBytes = new TextEncoder().encode(String(key));
  if (!keyBytes.length) return '';

  const sorted = parts
    .map((part) => String(part ?? ''))
    .filter((part) => part.length > 4)
    .sort((left, right) => parseInt(left.slice(0, 4), 10) - parseInt(right.slice(0, 4), 10));

  const chunks = [];
  let total = 0;
  for (const part of sorted) {
    let data;
    try {
      data = base64ToBytes(part.slice(4));
    } catch {
      continue;
    }
    for (let i = 0; i < data.length; i += 1) {
      data[i] ^= keyBytes[i % keyBytes.length];
    }
    chunks.push(data);
    total += data.length;
  }
  if (!total) return '';

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder('utf-8').decode(merged);

  // Mostly-garbled output means the key did not match; treat it as a failure.
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  if (text && replacementCount > text.length * 0.01) return '';
  return text;
}

/* ------------------------------------------------------------------ */
/* Page parsing                                                        */
/* ------------------------------------------------------------------ */

function pickAuthor(seriesInfo) {
  if (!seriesInfo) return '';
  // Only a row labelled "Tác giả"/"Author" is the author. Other rows hold the
  // status, genres or view counts, and reporting those as the author is wrong.
  const authorLabel = /tác\s*giả|author/i;
  for (const item of seriesInfo.querySelectorAll('.info-item')) {
    const label = item.querySelector('.info-name');
    if (!label || !authorLabel.test(cleanText(label.textContent))) continue;
    const value = item.querySelector('a, .info-value') || item;
    const text = cleanText(value.textContent).replace(cleanText(label.textContent), '').trim();
    if (text) return text;
  }
  return '';
}

/** Parse a light novel landing page. */
export function parseNovelPage(html, pageUrl) {
  const doc = parseHtml(html);
  const nameElement = doc.querySelector('span.series-name');
  const name = nameElement ? cleanText(nameElement.textContent) : 'Unknown Light Novel';

  const seriesInfo = doc.querySelector('.series-information');
  let seriesInfoHtml = '';
  if (seriesInfo) {
    const clone = seriesInfo.cloneNode(true);
    for (const anchor of clone.querySelectorAll('a')) {
      anchor.removeAttribute(':href');
      anchor.removeAttribute('@click');
    }
    seriesInfoHtml = safeXhtml(clone);
  }

  const summaryElement = doc.querySelector('.summary-content');
  let summaryHtml = '';
  if (summaryElement) {
    summaryHtml = safeXhtml(summaryElement.cloneNode(true));
  }

  const factElement = doc.querySelector('.fact-item');
  const factItemHtml = factElement ? safeXhtml(factElement.cloneNode(true)) : '';

  const volumes = [...doc.querySelectorAll('section.volume-list')].map((section) => {
    const titleElement = section.querySelector('span.sect-title');
    const link = section.querySelector('.volume-cover a[href]');
    const coverImage = section.querySelector('.volume-cover img[src]');
    return {
      name: titleElement ? cleanText(titleElement.textContent) : 'Unknown Volume',
      url: link ? absoluteUrl(link.getAttribute('href'), pageUrl) : '',
      cover: coverImage ? absoluteUrl(coverImage.getAttribute('src'), pageUrl) : '',
      chapters: [],
    };
  }).filter((volume) => volume.url);

  return {
    name,
    url: pageUrl,
    author: pickAuthor(seriesInfo),
    seriesInfoHtml,
    summaryHtml,
    factItemHtml,
    volumes,
  };
}

/** Parse a volume page: cover image + ordered chapter list. */
export function parseVolumePage(html, pageUrl) {
  const doc = parseHtml(html);

  let cover = '';
  const coverDiv = doc.querySelector('.series-cover');
  if (coverDiv) {
    const ratio = coverDiv.querySelector('.img-in-ratio');
    const style = ratio ? ratio.getAttribute('style') || '' : '';
    const match = style.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    if (match) cover = absoluteUrl(match[1], pageUrl);
    if (!cover) {
      const img = coverDiv.querySelector('img[src]');
      if (img) cover = absoluteUrl(img.getAttribute('src'), pageUrl);
    }
  }

  const seen = new Set();
  const chapters = [];
  for (const anchor of doc.querySelectorAll('ul.list-chapters li a[href]')) {
    const chapterUrl = absoluteUrl(anchor.getAttribute('href'), pageUrl);
    // Prefer the dedicated title span so the chapter date is not part of the name.
    const titleElement = anchor.querySelector('.chapter-name');
    const chapterName = cleanText((titleElement || anchor).textContent);
    if (!chapterUrl || !chapterName || seen.has(chapterUrl)) continue;
    seen.add(chapterUrl);
    chapters.push({ name: chapterName, url: chapterUrl });
  }

  return { cover, chapters };
}

function sniffImageMime(bytes, headerValue) {
  const header = String(headerValue || '').split(';')[0].trim().toLowerCase();
  if (IMAGE_MIME_EXTENSION[header]) return header;
  if (bytes.length > 3) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes.length > 11
      && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  }
  return 'image/jpeg';
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Cached renders keep the index they were first stored with; move their image
 * paths to the position this chapter has in the current download.
 */
function remapChapterIndex(chapter, index) {
  const prefix = `images/chapter_${index + 1}/`;
  return {
    title: chapter.title,
    cached: true,
    xhtml: String(chapter.xhtml || '').replace(/images\/chapter_\d+\//g, prefix),
    images: (chapter.images || []).map((image) => ({
      ...image,
      path: String(image.path || '').replace(/images\/chapter_\d+\//, prefix),
    })),
  };
}

export class HakoClient {
  constructor({ mode = 'slow', onLog = () => {}, useCache = true } = {}) {
    this.mode = MODES[mode] ? mode : 'slow';
    this.onLog = onLog;
    this.useCache = useCache;
    this.domains = DOMAINS.slice();
    this.cancelled = false;
    this.lastRequest = new Map();
    // Shared back-off deadline: when the site rate-limits one request, every
    // worker waits, because the limit is per IP, not per connection.
    this.retryAt = 0;
    // Adaptive cadence: a 429 slows every subsequent request, a run of
    // successes speeds them up again, so the crawl finds the site's ceiling
    // instead of relying on a hand-tuned delay.
    this.pacingDelay = this.config.requestDelay;
    this.successStreak = 0;
  }

  get config() {
    return MODES[this.mode];
  }

  log(message) {
    this.onLog(String(message));
  }

  cancel() {
    this.cancelled = true;
  }

  _checkCancelled() {
    if (this.cancelled) throw new CancelledError();
  }

  async _sleep(ms) {
    const step = 200;
    let remaining = ms;
    while (remaining > 0) {
      this._checkCancelled();
      const slice = Math.min(step, remaining);
      await sleep(slice);
      remaining -= slice;
    }
  }

  /** Probe each known domain and prefer the ones that answer. */
  async init() {
    const reachable = [];
    await Promise.all(DOMAINS.map(async (domain) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`https://${domain}/`, {
          signal: controller.signal,
          credentials: 'include',
          cache: 'no-store',
        });
        if (response.ok) reachable.push(domain);
      } catch {
        // Unreachable or blocked; ignored, other domains may work.
      } finally {
        clearTimeout(timer);
      }
    }));
    this.domains = DOMAINS.filter((domain) => reachable.includes(domain));
    if (!this.domains.length) {
      this.domains = DOMAINS.slice();
      this.log('Could not reach any supported domain directly; trying them in order.');
    } else {
      this.log(`Working domains: ${this.domains.join(', ')}`);
    }
    return this.domains;
  }

  _candidateUrls(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return [url];
    }
    const host = parsed.hostname.replace(/^www\./, '');
    if (!DOMAINS.includes(host)) return [parsed.toString()];
    const path = `${parsed.pathname}${parsed.search}`;
    return this.domains.map((domain) => `https://${domain}${path}`);
  }

  async _throttle(url, delayMs) {
    if (!delayMs) return;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = url;
    }
    const now = Date.now();
    const readyAt = this.lastRequest.get(host) || 0;
    const slot = Math.max(now, readyAt);
    // The next slot moves by exactly one delay. Jitter only shifts this wait,
    // so parallel workers share a steady cadence instead of queueing up
    // exponentially (each request used to add a whole delay to the backlog).
    const wait = slot - now + Math.random() * delayMs * 0.4;
    this.lastRequest.set(host, slot + delayMs);
    if (wait > 0) await this._sleep(wait);
  }

  /** Push every worker's next request back by `waitMs` (429 responses). */
  _pauseAll(waitMs) {
    const until = Date.now() + waitMs;
    if (until <= this.retryAt) return;
    this.retryAt = until;
    this.successStreak = 0;
    const slower = Math.max(Math.round(this.pacingDelay * 1.5), this.config.requestDelay);
    this.pacingDelay = Math.min(2000, slower + 50);
    this.log(`Rate limited by the site; pausing all requests for ${Math.round(waitMs / 1000)}s and slowing to one every ${this.pacingDelay}ms.`);
  }

  /** Called after each good response; gradually recovers the faster cadence. */
  _noteSuccess() {
    this.successStreak += 1;
    if (this.successStreak % 15 !== 0) return;
    this.pacingDelay = Math.max(this.config.requestDelay, Math.round(this.pacingDelay * 0.85));
  }

  async _waitForRetryWindow() {
    const wait = this.retryAt - Date.now();
    if (wait > 0) await this._sleep(wait);
  }

  async _requestOnce(url, { referer, timeout, delay } = {}) {
    this._checkCancelled();
    // An explicit delay (image downloads) is fixed; page requests follow the
    // adaptive cadence.
    const fixedDelay = typeof delay === 'number';
    const wait = fixedDelay ? delay : this.pacingDelay;

    for (let attempt = 0; ; attempt += 1) {
      await this._waitForRetryWindow();
      await this._throttle(url, wait);
      const response = await this._fetchOnce(url, { referer, timeout });
      if (response.ok && !fixedDelay) this._noteSuccess();
      if (response.status !== 429 || attempt >= 2) return response;
      const retryAfter = Number(response.headers.get('Retry-After'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10000;
      this._pauseAll(waitMs);
    }
  }

  async _fetchOnce(url, { referer, timeout } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || this.config.timeout);
    const init = {
      signal: controller.signal,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    };
    if (referer) {
      // Best-effort hotlink bypass; browsers ignore this for forbidden headers
      // but the extension origin is allowed to state a referrer.
      init.referrer = referer;
      init.referrerPolicy = 'unsafe-url';
    }
    try {
      return await fetch(url, init);
    } catch (error) {
      // Some browsers reject a cross-origin referrer; retry without it.
      if (referer && error instanceof TypeError) {
        const fallback = { ...init };
        delete fallback.referrer;
        delete fallback.referrerPolicy;
        return await fetch(url, fallback);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a site page, rotating through the known domains and retrying when
   * every domain is blocked or unreachable.
   */
  async request(url, options = {}) {
    const candidates = this._candidateUrls(url);
    let lastError = null;

    for (let pass = 0; pass < 3; pass += 1) {
      this._checkCancelled();
      let missingOnEveryMirror = true;
      for (const candidate of candidates) {
        let response;
        try {
          response = await this._requestOnce(candidate, options);
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          lastError = error;
          missingOnEveryMirror = false;
          continue;
        }
        if (response.ok) return response;
        if (response.status === 404 || response.status === 410) {
          // Another mirror may still serve this path, so keep going.
          lastError = new HakoError(`Not found (HTTP ${response.status}): ${candidate}`);
          continue;
        }
        missingOnEveryMirror = false;
        lastError = new HakoError(`HTTP ${response.status} from ${new URL(candidate).hostname}`);
      }

      // A path that is missing from every mirror will not appear on a retry.
      if (missingOnEveryMirror || pass === 2) break;
      const wait = pass === 0 ? 5000 : 20000;
      this.log(`${lastError ? lastError.message : 'Request failed'}; retrying in ${Math.round(wait / 1000)}s...`);
      await this._sleep(wait);
    }

    throw lastError || new HakoError(`Could not download ${url}`);
  }

  async requestText(url, options = {}) {
    const response = await this.request(url, options);
    return { text: await response.text(), url: response.url || url };
  }

  /** Fetch an image from any host; returns null when it cannot be downloaded. */
  async fetchImage(imageUrl, referer) {
    let url = String(imageUrl || '').trim();
    if (!url || url.startsWith('data:')) return null;
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:/i.test(url)) return null;
    // imgur pages without an extension need one appended (matches the desktop tool).
    if (url.includes('imgur.com') && !/\.[a-z]{3,4}$/i.test(url)) url += '.jpg';

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this._requestOnce(url, {
          referer,
          timeout: Math.max(this.config.timeout, 20000),
          delay: this.config.imageDelay,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (!bytes.length) throw new Error('empty response');
        const mime = sniffImageMime(bytes, response.headers.get('content-type'));
        return { data: bytes, mime, extension: IMAGE_MIME_EXTENSION[mime] || 'jpeg' };
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        this.log(`Image failed (${error.message}): ${url}`);
        if (attempt === 0) await this._sleep(1000);
      }
    }
    return null;
  }

  /** Load a novel landing page and its volume list. */
  async loadNovel(url) {
    const pageUrl = normalizePageUrl(url);
    const { text, url: finalUrl } = await this.requestText(pageUrl);
    const novel = parseNovelPage(text, finalUrl);
    novel.requestedUrl = pageUrl;
    if (!novel.volumes.length) {
      throw new HakoError('No volumes found on that page. Make sure the URL points at a light novel page.');
    }
    return novel;
  }

  /** Load the chapter list (and cover) of a single volume. */
  async loadVolume(volume) {
    const { text, url: finalUrl } = await this.requestText(volume.url);
    const details = parseVolumePage(text, finalUrl);
    volume.cover = details.cover || volume.cover;
    volume.chapters = details.chapters;
    return volume;
  }

  /** Fetch every volume's chapter list, `threadNum` at a time. */
  async loadAllVolumes(novel, onProgress = () => {}) {
    let done = 0;
    const total = novel.volumes.length;
    await mapPool(novel.volumes, this.config.threadNum, async (volume) => {
      try {
        await this.loadVolume(volume);
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        this.log(`Could not read volume "${volume.name}": ${error.message}`);
      }
      done += 1;
      onProgress({ done, total, message: `Reading volume ${done}/${total}` });
    });
    return novel;
  }

  /**
   * Fetch one chapter and render it as XHTML plus the images it references.
   */
  async renderChapter(chapter, index) {
    // A chapter that was rendered before is served from IndexedDB, which is what
    // makes a long, rate-limited download resumable.
    if (this.useCache) {
      const cached = await chapterCache.get(chapter.url);
      if (cached) return remapChapterIndex(cached, index);
    }
    const { text } = await this.requestText(chapter.url);
    const doc = parseHtml(text);

    const heading = doc.querySelector('.title-top h4');
    const title = heading
      ? cleanText(heading.textContent)
      : chapter.name || `Chapter ${index + 1}`;

    let container = null;
    const protectedDiv = doc.querySelector('#chapter-c-protected');
    if (protectedDiv && protectedDiv.getAttribute('data-s') === 'xor_shuffle') {
      const decoded = xorShuffleDecode(
        protectedDiv.getAttribute('data-c') || '',
        protectedDiv.getAttribute('data-k') || '',
      );
      if (decoded) {
        const decodedDoc = parseHtml(wrapFragment(decoded));
        container = decodedDoc.querySelector('#chapter-content') || decodedDoc.body;
      } else {
        this.log(`Protected content could not be decoded for "${title}".`);
      }
    }
    if (!container) container = doc.querySelector('#chapter-content');

    const images = [];
    let bodyHtml = '';
    if (container) {
      for (const element of container.querySelectorAll('p[target="__blank"]')) element.remove();
      const imgTags = [...container.querySelectorAll('img')];
      for (const [imageIndex, image] of imgTags.entries()) {
        const source = image.getAttribute('src')
          || image.getAttribute('data-src')
          || image.getAttribute('data-original')
          || '';
        if (!source || source.includes('chapter-banners')) {
          image.remove();
          continue;
        }
        const downloaded = await this.fetchImage(source, chapter.url);
        if (!downloaded) {
          image.remove();
          continue;
        }
        const path = `images/chapter_${index + 1}/image_${imageIndex}.${downloaded.extension}`;
        images.push({ path, mime: downloaded.mime, data: downloaded.data });
        image.setAttribute('src', path);
        image.setAttribute('style', 'display: block; margin-left: auto; margin-right: auto;');
      }
      bodyHtml = safeXhtml(container);
    } else {
      bodyHtml = '<p>Unable to decode protected content.</p>';
    }

    // Fold inline notes into the text, the way the desktop tool does.
    for (const note of doc.querySelectorAll('div[id^="note"]')) {
      const noteContent = note.querySelector('.note-content_real');
      if (!noteContent) continue;
      const tag = `[${note.id}]`;
      if (!tag || tag === '[]') continue;
      bodyHtml = bodyHtml.split(tag).join(`(Note: ${cleanText(noteContent.textContent)})`);
    }

    const xhtml = `<h4 style="text-align: center">${escapeXml(title)}</h4>\n${bodyHtml}`;
    const result = { title, xhtml, images };
    if (this.useCache) chapterCache.put(chapter.url, result).catch(() => {});
    return result;
  }

  /**
   * Download every chapter of one volume and assemble a complete EPUB.
   * @returns {Promise<Uint8Array>}
   */
  async makeVolumeEpub({ novel, volume, chapters = volume.chapters, onProgress = () => {} }) {
    if (!chapters.length) throw new HakoError(`Volume "${volume.name}" has no chapters to download.`);

    const total = chapters.length;
    let done = 0;
    let failed = 0;
    const rendered = await mapPool(chapters, this.config.threadNum, async (chapter, index) => {
      this._checkCancelled();
      try {
        const result = await this.renderChapter(chapter, index);
        return result;
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        failed += 1;
        this.log(`Chapter failed ("${chapter.name}"): ${error.message}`);
        return null;
      } finally {
        done += 1;
        onProgress({ done, total, message: `Chapter ${done}/${total}` });
      }
    });

    const usable = rendered.filter(Boolean);
    const reused = usable.filter((chapter) => chapter.cached).length;
    if (reused) this.log(`Reused ${reused} cached chapter(s) of "${volume.name}".`);
    if (!usable.length) {
      throw new HakoError(`No chapters of "${volume.name}" could be downloaded.`);
    }
    if (failed) this.log(`${failed} chapter(s) of "${volume.name}" failed and were skipped.`);

    let cover = null;
    if (volume.cover) {
      cover = await this.fetchImage(volume.cover, volume.url);
      if (!cover) this.log(`Cover image unavailable for "${volume.name}".`);
    }

    return buildEpub({ novel, volume, chapters: usable, cover });
  }
}
