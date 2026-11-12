#!/usr/bin/env node
/**
 * End-to-end smoke test: loads the unpacked extension into a real Chromium,
 * drives the real UI, and checks the files it really produces.
 *
 * The live sites are served from tests/fixtures by request interception;
 * everything else is genuine: the MV3 service worker, chrome.storage.local,
 * chrome.downloads, the content-script panel, the DOM and the EPUB bytes.
 *
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const fixturesDir = path.join(here, 'fixtures');
const novelUrl = 'https://ln.hako.vn/truyen/1-truyen-mau';
const volumePageUrl = 'https://ln.hako.vn/truyen/1-truyen-mau/tap-1';
const chapterPageUrl = 'https://ln.hako.vn/truyen/1-truyen-mau/tap-1/chuong-1';

const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hako2epub-smoke-'));
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hako2epub-profile-'));

const consoleErrors = [];
const pageErrors = [];
const dialogs = [];
let passed = 0;

function ok(name, detail = '') {
  passed += 1;
  console.log(`ok   - ${name}${detail ? ` (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 20000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP reader: enough to validate the EPUB the browser wrote.  */
/* ------------------------------------------------------------------ */

function readZip(bytes) {
  const view = Buffer.from(bytes);
  let eocd = -1;
  for (let i = view.length - 22; i >= 0 && i >= view.length - 22 - 0xffff; i -= 1) {
    if (view.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'zip has an end-of-central-directory record');
  const count = view.readUInt16LE(eocd + 10);
  let offset = view.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.readUInt32LE(offset), 0x02014b50, 'central directory signature');
    const method = view.readUInt16LE(offset + 10);
    const compressedSize = view.readUInt32LE(offset + 20);
    const nameLength = view.readUInt16LE(offset + 28);
    const extraLength = view.readUInt16LE(offset + 30);
    const commentLength = view.readUInt16LE(offset + 32);
    const localOffset = view.readUInt32LE(offset + 42);
    const name = view.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = view.readUInt16LE(localOffset + 26);
    const localExtraLength = view.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, { method, data: view.subarray(dataStart, dataStart + compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const chapterEntries = (entries) => [...entries.keys()].filter((name) => /^OEBPS\/chap_\d+\.xhtml$/.test(name));

/* ------------------------------------------------------------------ */
/* Browser setup                                                       */
/* ------------------------------------------------------------------ */

await fs.mkdir(path.join(profileDir, 'Default'), { recursive: true });
await fs.writeFile(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
  savefile: { default_directory: downloadDir },
}));

const browser = await puppeteer.launch({
  headless: true,
  userDataDir: profileDir,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--window-size=1200,900',
  ],
});

try {
  const worker = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
    { timeout: 30000 },
  );
  const extensionId = new URL(worker.url()).host;
  ok('extension loads unpacked with its MV3 service worker', extensionId);

  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
  });

  const novelHtml = (await fs.readFile(path.join(fixturesDir, 'novel.html'), 'utf8'))
    // Real novel pages declare a mobile viewport; the fixture does not.
    .replace('<head>', '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  const volumeHtml = await fs.readFile(path.join(fixturesDir, 'volume.html'), 'utf8');
  // Deliberately long chapters: the desktop tool stalls on very long ones.
  const filler = '  <p>Đoạn văn kiểm tra nội dung dài để chắc chắn không bị treo khi chương quá dài.</p>\n';
  const chapterHtml = (await fs.readFile(path.join(fixturesDir, 'chapter.html'), 'utf8'))
    .replace('<div id="chapter-content">', `<div id="chapter-content">\n${filler.repeat(900)}`);
  const imageBytes = await fs.readFile(path.join(extensionDir, 'icons', 'icon128.png'));

  let chapterRequests = 0;

  /** Serve the fixture site to one page (and to the panel's iframe). */
  async function serveFixtures(target, { chapters = true } = {}) {
    target.on('request', async (request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        await request.continue();
        return;
      }
      const corsHeaders = {
        'access-control-allow-origin': request.headers().origin || `chrome-extension://${extensionId}`,
        'access-control-allow-credentials': 'true',
      };
      try {
        if (url.hostname === 'img.example.com') {
          await request.respond({ status: 200, headers: { ...corsHeaders, 'content-type': 'image/png' }, body: imageBytes });
          return;
        }
        if (url.pathname === '/') {
          await request.respond({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><body>hako</body></html>' });
          return;
        }
        if (url.pathname === new URL(novelUrl).pathname) {
          await request.respond({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: novelHtml });
          return;
        }
        if (/\/tap-[12]$/.test(url.pathname)) {
          await request.respond({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: volumeHtml });
          return;
        }
        if (chapters && /\/chuong-\d+$/.test(url.pathname)) {
          chapterRequests += 1;
          await request.respond({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: chapterHtml });
          return;
        }
        await request.respond({ status: 404, headers: {}, body: 'not found' });
      } catch (error) {
        if (!/already handled|Request is already handled/i.test(error.message)) throw error;
      }
    });
    await target.setRequestInterception(true);
  }

  async function waitForEpubs(count, { timeout = 180000 } = {}) {
    return waitFor(async () => {
      const items = await page.evaluate(async () => (await chrome.downloads.search({ limit: 50 }))
        .filter((item) => item.filename.endsWith('.epub'))
        .map((item) => ({ filename: item.filename, state: item.state, error: item.error })));
      const complete = items.filter((item) => item.state === 'complete');
      assert.deepEqual(items.filter((item) => item.state === 'interrupted'), [], 'no download failed');
      return complete.length >= count ? complete : null;
    }, { timeout, interval: 250, label: `${count} completed EPUB downloads` });
  }

  /* ---------------------------------------------------------------- */
  /* The panel page itself                                            */
  /* ---------------------------------------------------------------- */

  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleErrors.push(message.text()));
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await serveFixtures(page);

  await page.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 15000 });

  // Headless Chrome cannot answer the optional image prompt; record the same
  // choice a user makes by declining it, then reload so the page picks it up.
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(stored.settings || {}), imagesDeclined: true } });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 15000 });

  const manifestVersion = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8')).version;
  const surface = await page.evaluate(() => ({
    version: document.getElementById('versionBadge').textContent,
    tabs: document.querySelectorAll('.tab').length,
    library: Boolean(document.getElementById('libraryList')),
    update: Boolean(document.getElementById('updateResults')),
    settings: Boolean(document.getElementById('folderInput')),
  }));
  assert.equal(surface.version, `v${manifestVersion}`);
  assert.equal(surface.tabs, 0, 'no tab bar');
  assert.equal(surface.library, false, 'no library panel');
  assert.equal(surface.update, false, 'no update panel');
  assert.equal(surface.settings, false, 'no settings panel');
  ok('panel is download-only', `${surface.version}, no update/library/settings UI`);

  await page.$eval('#novelUrl', (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, novelUrl);
  await page.evaluate(() => document.getElementById('loadForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
  await page.waitForFunction(() => document.querySelectorAll('#novelView tbody tr').length === 2, { timeout: 20000 });
  const novel = await page.evaluate(() => ({
    title: document.querySelector('.novel-info h2').textContent,
    rows: document.querySelectorAll('#novelView tbody tr').length,
    summary: document.getElementById('downloadSummary').textContent,
    button: document.getElementById('downloadBtn').textContent,
  }));
  assert.equal(novel.button, 'Download EPUB');
  ok('parses the novel page in a real browser', `${novel.title}, ${novel.summary}`);

  const downloadStart = Date.now();
  await page.click('#downloadBtn');
  await page.waitForFunction(() => !document.getElementById('loadBtn').disabled, { timeout: 180000 });
  const downloadSeconds = (Date.now() - downloadStart) / 1000;
  const epubs = await waitForEpubs(2);

  let totalChapters = 0;
  let imageCount = 0;
  for (const epub of epubs) {
    const entries = readZip(await fs.readFile(epub.filename));
    assert.equal([...entries.keys()][0], 'mimetype', 'mimetype comes first');
    assert.equal(entries.get('mimetype').method, 0, 'mimetype is stored');
    assert.equal(entries.get('mimetype').data.toString('utf8'), 'application/epub+zip');
    totalChapters += chapterEntries(entries).length;
    imageCount += [...entries.keys()].filter((name) => name.startsWith('OEBPS/images/')).length;
  }
  assert.equal(totalChapters, 6, `chapters across both EPUBs: ${totalChapters}`);
  ok('Download EPUB writes valid files', `${epubs.length} volumes, ${totalChapters} chapters, ${imageCount} images`);
  ok('very long chapters complete without stalling', `900 filler paragraphs, ${downloadSeconds.toFixed(1)}s`);

  const requestsBeforeResume = chapterRequests;
  await page.click('#downloadBtn');
  await page.waitForFunction(() => !document.getElementById('loadBtn').disabled, { timeout: 180000 });
  assert.equal(chapterRequests, requestsBeforeResume, 'a repeat download refetched no chapter');
  ok('second run reused cached chapters', `0 of ${requestsBeforeResume} chapters refetched`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 15000 });
  const cachedAfterReload = await page.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.open('hako2epub-chapters', 1);
    request.onerror = () => resolve(-1);
    request.onsuccess = () => {
      const db = request.result;
      const count = db.transaction('chapters', 'readonly').objectStore('chapters').count();
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => resolve(-1);
    };
  }));
  assert.ok(cachedAfterReload >= 3, `cached chapters after reload: ${cachedAfterReload}`);
  ok('chapter cache survives a page reload', `${cachedAfterReload} chapters cached`);

  /* ---------------------------------------------------------------- */
  /* In-page launcher and panel download                              */
  /* ---------------------------------------------------------------- */

  const sitePage = await browser.newPage();
  sitePage.on('pageerror', (error) => pageErrors.push(error.message));
  await serveFixtures(sitePage);
  await sitePage.goto(novelUrl, { waitUntil: 'domcontentloaded' });
  await sitePage.waitForSelector('#hako2epub-launcher', { timeout: 15000 });
  ok('launcher is injected on a novel page', '#hako2epub-launcher');

  await sitePage.click('#hako2epub-launcher');
  const panelSrc = await sitePage.$eval('#hako2epub-panel iframe', (element) => element.src);
  assert.match(panelSrc, /\/app\.html\?url=https%3A%2F%2Fln\.hako\.vn%2Ftruyen%2F1-truyen-mau$/);
  const panelFrame = await waitFor(
    async () => sitePage.frames().find((frame) => frame.url().includes('/app.html?url=')) || null,
    { timeout: 20000, label: 'the panel iframe' },
  );
  await panelFrame.waitForFunction(() => document.querySelectorAll('#novelView tbody tr').length === 2, { timeout: 30000 });
  const panelView = await panelFrame.evaluate(() => ({
    title: document.querySelector('.novel-info h2').textContent,
    tabs: document.querySelectorAll('.tab').length,
  }));
  assert.equal(panelView.tabs, 0, 'the panel has no tabs');
  ok('panel loads the novel it was opened from', `${panelView.title}, 2 volumes`);

  const beforeFiles = new Set(await page.evaluate(async () => (await chrome.downloads.search({ limit: 50 }))
    .filter((item) => item.filename.endsWith('.epub')).map((item) => item.filename)));
  await panelFrame.click('#downloadBtn');
  await panelFrame.waitForFunction(() => !document.getElementById('loadBtn').disabled, { timeout: 180000 });
  const panelEpubs = await waitFor(async () => {
    const items = await page.evaluate(async () => (await chrome.downloads.search({ limit: 50 }))
      .filter((item) => item.filename.endsWith('.epub'))
      .map((item) => ({ filename: item.filename, state: item.state })));
    const fresh = items.filter((item) => item.state === 'complete' && !beforeFiles.has(item.filename));
    return fresh.length >= 2 ? fresh : null;
  }, { timeout: 180000, interval: 300, label: 'the panel to write one EPUB per volume' });
  let panelChapters = 0;
  for (const epub of panelEpubs) {
    panelChapters += chapterEntries(readZip(await fs.readFile(epub.filename))).length;
  }
  assert.equal(panelChapters, 6, `chapters across the panel's EPUBs: ${panelChapters}`);
  ok('panel Download button writes valid EPUBs', `${panelEpubs.length} volumes, ${panelChapters} chapters`);

  await sitePage.click('#hako2epub-close');
  assert.equal(await sitePage.$eval('#hako2epub-panel', (element) => element.hidden), true, 'close hides the panel');

  const serviceWorker = await (await browser.waitForTarget((target) => target.type() === 'service_worker')).worker();
  const tabsBefore = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).length);
  const opened = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => (candidate.url || '') === 'https://ln.hako.vn/truyen/1-truyen-mau');
    if (!tab) return { opened: false, reason: 'site tab not found' };
    return chrome.tabs.sendMessage(tab.id, { type: 'hako2epub:open', url: tab.url });
  });
  assert.equal(opened && opened.opened, true, `content script acknowledged: ${JSON.stringify(opened)}`);
  await sitePage.waitForFunction(() => !document.getElementById('hako2epub-panel').hidden, { timeout: 5000 });
  const tabsAfter = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).length);
  assert.equal(tabsAfter, tabsBefore, 'no extra tab was opened');
  ok('service worker opens the panel instead of a tab', `${tabsBefore} tab(s) before and after`);

  /* ---------------------------------------------------------------- */
  /* Mobile web layout                                                */
  /* ---------------------------------------------------------------- */

  const mobilePage = await browser.newPage();
  mobilePage.on('pageerror', (error) => pageErrors.push(error.message));
  await serveFixtures(mobilePage, { chapters: false });
  await mobilePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mobilePage.goto(novelUrl, { waitUntil: 'domcontentloaded' });
  await mobilePage.waitForSelector('#hako2epub-launcher', { timeout: 15000 });
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true,
    'the launcher does not make the page scroll sideways');
  await mobilePage.click('#hako2epub-launcher');
  const mobileFrame = await waitFor(
    async () => mobilePage.frames().find((frame) => frame.url().includes('/app.html?url=')) || null,
    { timeout: 20000, label: 'the mobile panel iframe' },
  );
  await mobileFrame.waitForFunction(() => document.querySelectorAll('#novelView tbody tr').length === 2, { timeout: 30000 });
  const sheet = await mobilePage.$eval('#hako2epub-panel .hako2epub-sheet', (element) => {
    const box = element.getBoundingClientRect();
    return { width: Math.round(box.width), viewport: window.innerWidth };
  });
  const layout = await mobileFrame.evaluate(() => {
    const button = document.getElementById('downloadBtn');
    const table = document.querySelector('.table-wrap');
    return {
      bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
      buttonVisible: Boolean(button && button.getBoundingClientRect().width),
      tableOverflowX: table ? getComputedStyle(table).overflowX : '',
    };
  });
  assert.ok(sheet.width >= sheet.viewport - 2, `panel fills the width: ${JSON.stringify(sheet)}`);
  assert.ok(layout.bodyOverflow <= 1, `no sideways scroll inside the panel: ${JSON.stringify(layout)}`);
  assert.equal(layout.buttonVisible, true, 'the Download button is visible on mobile');
  assert.equal(layout.tableOverflowX, 'auto', 'the volume table scrolls instead of overflowing');
  ok('mobile layout: panel fills the screen and the table scrolls', `${sheet.viewport}px wide`);

  /* ---------------------------------------------------------------- */

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(dialogs, [], `chapter scripts did not run: ${dialogs.join(' | ')}`);
  const unexpected = consoleErrors.filter(
    (message) => !/permission|image access|Content Security Policy|inline event handler|Failed to load resource/i.test(message),
  );
  assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.join(' | ')}`);
  ok('no page errors and chapter scripts stayed blocked');

  console.log(`\n${passed}/${passed} smoke checks passed.`);
} finally {
  await browser.close();
  await fs.rm(downloadDir, { recursive: true, force: true });
  await fs.rm(profileDir, { recursive: true, force: true });
}
