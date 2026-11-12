// Node test runner for the extension's parsing and EPUB generation.
// Run with: npm install && npm test   (from extension/tests)

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(here, 'fixtures', name), 'utf8');

// The modules expect a browser DOM; give them jsdom's implementation.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;

const {
  HakoClient, parseNovelPage, parseVolumePage, xorShuffleDecode,
  formatFilename, epubFilename, normalizePageUrl, HakoError, samePath,
} = await import('../src/hako.js');
const { buildEpub } = await import('../src/epub.js');
const { ZipWriter } = await import('../src/zip.js');
const store = await import('../src/store.js');

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
));

const CHAPTER_URL = 'https://ln.hako.vn/truyen/1-truyen-mau/tap-1/chuong-1';
const NOVEL_URL = 'https://ln.hako.vn/truyen/1-truyen-mau';

/** Encode text the way docln does, so the decoder can be tested both ways. */
function encodeXorShuffle(text, key, { shuffle = true } = {}) {
  const keyBytes = new TextEncoder().encode(key);
  const data = new TextEncoder().encode(text);
  const chunkSize = 32;
  const parts = [];
  for (let start = 0, index = 0; start < data.length; start += chunkSize, index += 1) {
    const chunk = data.slice(start, start + chunkSize);
    for (let i = 0; i < chunk.length; i += 1) {
      chunk[i] ^= keyBytes[i % keyBytes.length];
    }
    parts.push(String(index).padStart(4, '0') + Buffer.from(chunk).toString('base64'));
  }
  if (shuffle) parts.reverse();
  return JSON.stringify(parts);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------------ */

test('normalizePageUrl accepts supported mirrors and rejects others', () => {
  assert.equal(normalizePageUrl('ln.hako.vn/truyen/1-slug'), 'https://ln.hako.vn/truyen/1-slug');
  assert.equal(normalizePageUrl('https://docln.sbs/truyen/2-x/#comments'), 'https://docln.sbs/truyen/2-x/');
  assert.throws(() => normalizePageUrl('https://example.com/truyen/1'), HakoError);
  assert.throws(() => normalizePageUrl(''), HakoError);
});

test('filenames match the desktop tool', () => {
  assert.equal(formatFilename('Truyện Mẫu: Khởi Đầu'), 'Truyện-Mẫu-Khởi-Đầu');
  assert.equal(formatFilename('a/b\\c?d!e.f:g'), 'abcdefg');
  assert.equal(epubFilename('Tập 1: Khởi Đầu', 'Truyện Mẫu'), 'Tập-1-Khởi-Đầu-Truyện-Mẫu.epub');
  assert.equal(formatFilename('x'.repeat(140)).length, 100);
});

test('samePath ignores the rotating domain', () => {
  assert.ok(samePath('https://ln.hako.vn/truyen/1-x/', 'https://docln.net/truyen/1-x/'));
  assert.ok(!samePath('https://ln.hako.vn/truyen/1-x/', 'https://ln.hako.vn/truyen/2-y/'));
});

test('parseNovelPage reads metadata and volume links', async () => {
  const html = await fixture('novel.html');
  const novel = parseNovelPage(html, NOVEL_URL);
  assert.equal(novel.name, 'Truyện Mẫu: Khởi Đầu');
  assert.equal(novel.author, 'Tác Giả Mẫu');
  assert.equal(novel.volumes.length, 2);
  assert.equal(novel.volumes[0].url, 'https://ln.hako.vn/truyen/1-truyen-mau/tap-1');
  assert.equal(novel.volumes[1].url, 'https://docln.net/truyen/1-truyen-mau/tap-2');
  assert.match(novel.seriesInfoHtml, /Tác Giả Mẫu/);
  assert.ok(!novel.seriesInfoHtml.includes(':href'), 'Vue binding attributes should be stripped');
  assert.match(novel.summaryHtml, /Tóm tắt nội dung/);
  assert.match(novel.factItemHtml, /lượt xem/);
});

test('parseVolumePage reads the cover and de-duplicates chapters', async () => {
  const html = await fixture('volume.html');
  const volume = parseVolumePage(html, 'https://ln.hako.vn/truyen/1-truyen-mau/tap-1');
  assert.equal(volume.cover, 'https://img.example.com/vol1-big.jpg');
  assert.equal(volume.chapters.length, 3);
  assert.equal(volume.chapters[0].name, 'Chương 1: Khởi đầu');
  assert.equal(volume.chapters[0].url, 'https://ln.hako.vn/truyen/1-truyen-mau/tap-1/chuong-1');
  assert.equal(volume.chapters[2].url, 'https://docln.sbs/truyen/1-truyen-mau/tap-1/chuong-3');
});

test('xorShuffleDecode round-trips protected content', () => {
  const text = 'Chương 1: Khởi đầu.\n'.repeat(20) + 'Kết thúc!';
  const key = 'a1B2c3D4e5';
  assert.equal(xorShuffleDecode(encodeXorShuffle(text, key), key), text);
  assert.equal(xorShuffleDecode(encodeXorShuffle(text, key), 'wrong-key-value'), '');
  assert.equal(xorShuffleDecode('not json', key), '');
  assert.equal(xorShuffleDecode('', key), '');
});

test('renderChapter extracts content, images and notes', async () => {
  const html = await fixture('chapter.html');
  const client = new HakoClient({ mode: 'fast', useCache: false });
  const fetched = [];
  client.requestText = async () => ({ text: html, url: CHAPTER_URL });
  client.fetchImage = async (src) => {
    fetched.push(src);
    return { data: PNG, mime: 'image/png', extension: 'png' };
  };

  const rendered = await client.renderChapter({ name: 'Chương 1', url: CHAPTER_URL }, 0);
  assert.equal(rendered.title, 'Chương 1: Khởi đầu');
  assert.equal(rendered.images.length, 2, 'banner images and ad paragraphs are dropped');
  assert.deepEqual(fetched.sort(), [
    '//img.example.com/chap1-b.png',
    'https://img.example.com/chap1-a.png',
  ]);
  assert.match(rendered.xhtml, /images\/chapter_1\/image_0\.png/);
  assert.match(rendered.xhtml, /images\/chapter_1\/image_2\.png/);
  assert.ok(!rendered.xhtml.includes('chapter-banners'));
  assert.match(rendered.xhtml, /\(Note: Ghi chú đây\)/);
  assert.ok(!rendered.xhtml.includes('[note1]'));
  assert.ok(!rendered.xhtml.includes('<script'), 'scripts must be removed');
  assert.ok(!rendered.xhtml.includes('onclick'), 'inline handlers must be removed');
  assert.match(rendered.xhtml, /&amp; ký tự đặc biệt/);
});

test('renderChapter decodes xor_shuffle chapters without a browser', async () => {
  const key = 'k3yF0rT3st';
  const inner = '<p>Nội dung được bảo vệ.</p><img src="https://img.example.com/protected.png">';
  const html = `<!doctype html><html><body>
    <div class="title-top"><h4>Chương bảo vệ</h4></div>
    <div id="chapter-c-protected" data-s="xor_shuffle" data-k="${key}" data-c="${encodeXorShuffle(inner, key).replace(/"/g, '&quot;')}"></div>
  </body></html>`;
  const client = new HakoClient({ mode: 'fast', useCache: false });
  client.requestText = async () => ({ text: html, url: CHAPTER_URL });
  client.fetchImage = async () => ({ data: PNG, mime: 'image/png', extension: 'png' });

  const rendered = await client.renderChapter({ name: 'Chương bảo vệ', url: CHAPTER_URL }, 1);
  assert.match(rendered.xhtml, /Nội dung được bảo vệ\./);
  assert.match(rendered.xhtml, /images\/chapter_2\/image_0\.png/);
  assert.equal(rendered.images.length, 1);
});

test('renderChapter reports undecodable protected content', async () => {
  const html = `<!doctype html><html><body>
    <div class="title-top"><h4>Chương hỏng</h4></div>
    <div id="chapter-c-protected" data-s="xor_shuffle" data-k="key" data-c="%7B%7D"></div>
  </body></html>`;
  const client = new HakoClient({ mode: 'fast', useCache: false });
  client.requestText = async () => ({ text: html, url: CHAPTER_URL });
  client.fetchImage = async () => null;
  const rendered = await client.renderChapter({ name: 'Chương hỏng', url: CHAPTER_URL }, 0);
  assert.match(rendered.xhtml, /Unable to decode protected content/);
});

test('makeVolumeEpub produces a complete EPUB', async () => {
  const novel = parseNovelPage(await fixture('novel.html'), NOVEL_URL);
  const volume = parseVolumePage(await fixture('volume.html'), novel.volumes[0].url);
  const html = await fixture('chapter.html');

  const client = new HakoClient({ mode: 'fast', useCache: false });
  client.requestText = async (url) => ({ text: html, url });
  client.fetchImage = async (src) => (src.includes('vol1-big')
    ? { data: PNG, mime: 'image/png', extension: 'png' }
    : { data: PNG, mime: 'image/png', extension: 'png' });

  const bytes = await client.makeVolumeEpub({
    novel,
    volume: { ...novel.volumes[0], ...volume },
    chapters: volume.chapters.slice(0, 2),
  });
  assert.ok(bytes.length > 1000);
  assert.equal(Buffer.from(bytes.slice(0, 4)).toString('binary'), 'PK\x03\x04');

  const text = Buffer.from(bytes).toString('binary');
  assert.ok(text.includes('OEBPS/content.opf'));
  assert.ok(text.includes('OEBPS/chap_1.xhtml'));
  assert.ok(text.includes('OEBPS/chap_2.xhtml'));
  assert.ok(text.includes('META-INF/container.xml'));
  assert.ok(text.includes('cover.png'));

  const outDir = path.join(here, '.output');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'sample.epub'), bytes);
});

test('buildEpub stores mimetype first and references every spine item', async () => {
  const novel = parseNovelPage(await fixture('novel.html'), NOVEL_URL);
  const volume = { name: 'Tập 1: Khởi Đầu', chapters: [] };
  const chapters = [
    { title: 'Chương 1', xhtml: '<p>Một</p>', images: [] },
    { title: 'Chương 2', xhtml: '<p>Hai</p>', images: [{ path: 'images/chapter_2/image_0.png', mime: 'image/png', data: PNG }] },
  ];
  const bytes = buildEpub({ novel, volume, chapters, cover: { mime: 'image/png', data: PNG } });
  const view = Buffer.from(bytes);
  assert.equal(view.subarray(0, 2).toString(), 'PK');

  // Local file header: method 0 (store) and the name "mimetype" at offset 30.
  assert.equal(view.readUInt32LE(0), 0x04034b50);
  assert.equal(view.readUInt16LE(8), 0, 'mimetype must be stored, not deflated');
  assert.equal(view.subarray(30, 38).toString(), 'mimetype');
  assert.equal(view.subarray(38, 58).toString(), 'application/epub+zip');

  const text = view.toString('utf8');
  const opf = text.slice(text.indexOf('<package '), text.indexOf('</package>'));
  assert.match(opf, /id="chap-2"/);
  assert.match(opf, /idref="chap-2"/);
  assert.match(opf, /cover-image/);
});

test('ZipWriter produces verifiable archives', () => {
  const zip = new ZipWriter();
  zip.add('a.txt', 'hello');
  zip.add('b/c.txt', 'world');
  zip.add('a.txt', 'replaced');
  const view = Buffer.from(zip.build());
  assert.equal(view.subarray(0, 2).toString(), 'PK');
  // The end-of-central-directory record reports the entry count; replacing a
  // path must not add a second entry.
  assert.equal(view.readUInt16LE(view.length - 22 + 10), 2);
  const text = view.toString('utf8');
  assert.equal(text.split('a.txt').length - 1, 2, 'one local header + one central header');
  assert.ok(!text.includes('hello'), 'replaced entry must be rewritten');
  assert.ok(text.includes('replaced'));
});

test('request falls back to the next mirror on 404', async () => {
  const client = new HakoClient({ mode: 'fast', useCache: false });
  client.domains = ['ln.hako.vn', 'docln.net'];
  const originalFetch = globalThis.fetch;
  const calls = [];
  const statuses = new Map([
    ['https://ln.hako.vn/truyen/9-x', 404],
    ['https://docln.net/truyen/9-x', 200],
  ]);
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const status = statuses.get(target) ?? 500;
    return new Response(status === 200 ? '<html><body>ok</body></html>' : 'missing', { status });
  };
  try {
    const response = await client.request('https://ln.hako.vn/truyen/9-x');
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['https://ln.hako.vn/truyen/9-x', 'https://docln.net/truyen/9-x']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request reports not-found once every mirror is missing the page', async () => {
  const client = new HakoClient({ mode: 'fast', useCache: false });
  client.domains = ['ln.hako.vn', 'docln.net'];
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('missing', { status: 404 });
  };
  try {
    await assert.rejects(client.request('https://ln.hako.vn/truyen/8-y'), /Not found \(HTTP 404\)/);
    assert.equal(calls.length, 2, 'each mirror is tried once, without pointless retry delays');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('throttle keeps parallel workers on a steady cadence', async () => {
  const client = new HakoClient({ mode: 'slow', useCache: false });
  const waits = [];
  client._sleep = async (ms) => { waits.push(ms); };
  await Promise.all([0, 1, 2, 3].map(() => client._throttle('https://docln.sbs/truyen/1/tap-1/chuong-1', 100)));
  assert.equal(waits.length, 4);
  assert.ok(Math.max(...waits) < 400, `waits stay bounded instead of compounding: ${waits.map(Math.round)}`);
});

test('429s slow the cadence and successes recover it', () => {
  const client = new HakoClient({ mode: 'slow', useCache: false });
  const base = client.pacingDelay;
  client._pauseAll(1000);
  assert.ok(client.pacingDelay > base, `slower after a 429: ${client.pacingDelay} vs ${base}`);
  for (let i = 0; i < 90; i += 1) client._noteSuccess();
  assert.ok(client.pacingDelay >= base, 'never faster than the mode baseline');
  assert.ok(client.pacingDelay < 1000, `recovers towards the baseline: ${client.pacingDelay}`);
});

test('a 429 pauses all requests and retries the same page', async () => {
  const messages = [];
  const client = new HakoClient({ mode: 'fast', useCache: false, onLog: (message) => messages.push(message) });
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '0.02' } });
    }
    return new Response('<html><body><h1>ok</h1></body></html>', { status: 200 });
  };
  try {
    const { text } = await client.requestText('https://docln.sbs/truyen/1/tap-1/chuong-1');
    assert.match(text, /ok/);
    assert.equal(calls.length, 2, 'the page was requested once more after the pause');
    assert.equal(calls[0], calls[1], 'the same page was retried, not another mirror');
    assert.ok(client.retryAt > 0, 'a shared back-off deadline was recorded');
    assert.ok(messages.some((message) => /Rate limited/.test(message)), `logged the pause: ${JSON.stringify(messages)}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('buildEpub stores an SVG cover as svg with its own media type', async () => {
  const novel = parseNovelPage(await fixture('novel.html'), NOVEL_URL);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const bytes = buildEpub({
    novel,
    volume: { name: 'Tập 1' },
    chapters: [{ title: 'Chương 1', xhtml: '<p>x</p>' }],
    cover: { mime: 'image/svg+xml', data: svg },
  });
  const text = Buffer.from(bytes).toString('utf8');
  assert.ok(text.includes('OEBPS/cover.svg'));
  assert.match(text, /href="cover\.svg" media-type="image\/svg\+xml"/);
  assert.ok(!text.includes('cover.jpeg'));
});

test('settings keep the downloads folder a safe relative path', () => {
  assert.equal(store.sanitizeFolder('  my-novels  '), 'my-novels');
  assert.equal(store.sanitizeFolder('a/b'), 'a/b');
  assert.equal(store.sanitizeFolder('../../etc'), 'etc');
  assert.equal(store.sanitizeFolder('weird/../folder'), 'weird/folder');
  assert.equal(store.sanitizeFolder('C:\\evil'), 'Cevil');
  assert.equal(store.sanitizeFolder(''), 'hako2epub');
  assert.equal(store.sanitizeFolder('  '), 'hako2epub');
});

/* ------------------------------------------------------------------ */

let failed = 0;
test('the author only comes from a "Tác giả" row', () => {
  const base = (authorRow) => `<!doctype html><html><body>
    <span class="series-name">Truyện Không Tác Giả</span>
    <div class="series-information">
      <div class="info-item"><span class="info-name">Tình trạng</span><span>Đã hoàn thành</span></div>
      ${authorRow}
    </div></body></html>`;
  const withAuthor = parseNovelPage(
    base('<div class="info-item"><span class="info-name">Tác giả</span><a href="/tac-gia/1">Người Viết Thật</a></div>'),
    'https://ln.hako.vn/truyen/9-x',
  );
  assert.equal(withAuthor.author, 'Người Viết Thật');

  // A page without an author row (the live AI-translated novels) must not
  // report the status row as the author.
  const withoutAuthor = parseNovelPage(base(''), 'https://ln.hako.vn/truyen/9-x');
  assert.equal(withoutAuthor.author, '');
});

test('rendered chapters are cached and reused on the next run', async () => {
  await import('fake-indexeddb/auto');
  const { chapterCache } = await import('../src/cache.js');
  await chapterCache.clear();
  const chapterHtml = await fixture('chapter.html');
  const client = new HakoClient({ mode: 'fast' });
  let fetches = 0;
  client.requestText = async (url) => { fetches += 1; return { text: chapterHtml, url }; };
  client.fetchImage = async () => ({ mime: 'image/png', extension: 'png', data: PNG });
  const chapter = { name: 'Chương 1: Khởi đầu', url: 'https://docln.sbs/truyen/1/tap-1/chuong-1' };

  const first = await client.renderChapter(chapter, 0);
  assert.equal(fetches, 1);
  assert.ok(first.images.length >= 1);
  assert.equal(await chapterCache.count(), 1);
  assert.ok(chapterCache.stats().memory >= 1, 'the chapter is also held in RAM');

  // A different client in the same tab is served from RAM: no network call.
  const otherClient = new HakoClient({ mode: 'fast' });
  otherClient.requestText = async () => { fetches += 1; throw new Error('must not fetch'); };
  const fromRam = await otherClient.renderChapter(chapter, 4);
  assert.equal(fetches, 1, 'RAM hit must not request the chapter');
  assert.equal(fromRam.cached, true);

  // A later run (or a restarted download) must not fetch this chapter again.
  const second = await client.renderChapter(chapter, 4);
  assert.equal(fetches, 1, 'the cached chapter must not be requested twice');
  assert.equal(second.cached, true);
  assert.match(second.xhtml, /images\/chapter_5\//);
  assert.ok(second.images.every((image) => image.path.startsWith('images/chapter_5/')));

  const uncached = new HakoClient({ mode: 'fast', useCache: false });
  uncached.requestText = async (url) => { fetches += 1; return { text: chapterHtml, url }; };
  uncached.fetchImage = async () => ({ mime: 'image/png', extension: 'png', data: PNG });
  await uncached.renderChapter(chapter, 0);
  assert.equal(fetches, 2, 'useCache: false always refetches');
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(`       ${error && error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed.`);
if (failed) process.exitCode = 1;
