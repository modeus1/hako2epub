// hako2epub — download-only UI controller.

import {
  HakoClient, CancelledError, TOOL_VERSION, novelFolder, epubFilename,
} from './src/hako.js';
import { cleanText } from './src/dom.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './src/store.js';

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Create an element. `props` supports class, text, boolean attributes and on*
 * event handlers. Markup is always built from DOM nodes, so site data never
 * reaches innerHTML.
 */
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(append);
      return;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  append(children);
  return node;
}

function htmlToText(markup) {
  if (!markup) return '';
  const doc = new DOMParser().parseFromString(String(markup), 'text/html');
  return cleanText(doc.body ? doc.body.textContent || '' : '');
}

/* ------------------------------------------------------------------ */
/* State + elements                                                    */
/* ------------------------------------------------------------------ */

const IMAGE_ORIGINS = ['*://*/*'];

const state = {
  settings: { ...DEFAULT_SETTINGS },
  novel: null,
  rows: [],
  busy: false,
  activeClient: null,
};

const elements = {
  versionBadge: $('#versionBadge'),
  loadForm: $('#loadForm'),
  novelUrl: $('#novelUrl'),
  novelView: $('#novelView'),
  activityTitle: $('#activityTitle'),
  cancelBtn: $('#cancelBtn'),
  clearLogBtn: $('#clearLogBtn'),
  progressBar: $('#progressBar'),
  progressText: $('#progressText'),
  progressCount: $('#progressCount'),
  log: $('#log'),
};

/* ------------------------------------------------------------------ */
/* Activity panel                                                      */
/* ------------------------------------------------------------------ */

function log(message, kind = 'info') {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = h('div', { class: kind === 'error' ? 'error' : '', text: `[${time}] ${message}` });
  elements.log.append(line);
  while (elements.log.childElementCount > 400) elements.log.firstElementChild.remove();
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setProgress(done, total, message) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  elements.progressBar.style.width = `${percent}%`;
  if (message) elements.progressText.textContent = message;
  elements.progressCount.textContent = total > 0 ? `${done} / ${total}` : '';
}

function setBusy(busy, title) {
  state.busy = busy;
  elements.activityTitle.textContent = title || 'Activity';
  elements.cancelBtn.classList.toggle('hidden', !busy);
  for (const button of document.querySelectorAll('button')) {
    if (button.id === 'cancelBtn') continue;
    button.disabled = busy;
  }
  if (!busy) updateDownloadSummary();
}

/** Run a task with a fresh client, consistent logging and cancel support. */
async function runTask(title, task) {
  if (state.busy) return;
  const client = new HakoClient({ mode: state.settings.mode, onLog: (message) => log(message) });
  state.activeClient = client;
  setBusy(true, title);
  setProgress(0, 0, title);
  log(`${title}... (${client.config.label.toLowerCase()} mode)`);
  try {
    await client.init();
    await task(client);
    setProgress(1, 1, 'Finished');
    log(`${title}: done.`);
  } catch (error) {
    if (error instanceof CancelledError) {
      elements.progressText.textContent = 'Cancelled';
      log('Cancelled.', 'error');
    } else {
      elements.progressText.textContent = 'Failed';
      log(error && error.message ? error.message : String(error), 'error');
    }
  } finally {
    state.activeClient = null;
    setBusy(false, 'Activity');
  }
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

function revokeLater(url, downloadId) {
  if (!Number.isFinite(downloadId)) {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      chrome.downloads.onChanged.removeListener(listener);
      URL.revokeObjectURL(url);
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

/** Save a blob through the downloads API, falling back to an anchor click. */
async function downloadBlob(blob, relativePath) {
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: relativePath,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    revokeLater(url, downloadId);
    return downloadId;
  } catch (error) {
    log(`Downloads API refused the file (${error.message}); using a plain browser download instead.`, 'error');
    const link = h('a', { href: url, download: relativePath.split('/').pop() });
    document.body.append(link);
    link.click();
    link.remove();
    revokeLater(url, null);
    return null;
  }
}

function saveEpub(bytes, relativePath) {
  return downloadBlob(new Blob([bytes], { type: 'application/epub+zip' }), relativePath);
}

function epubPath(novelName, volumeName) {
  const folder = state.settings.folder || 'hako2epub';
  return `${folder}/${novelFolder(novelName)}/${epubFilename(volumeName, novelName)}`;
}

/** Ask for image host access. Called straight from a click so the gesture survives. */
async function ensureImagePermission() {
  if (state.settings.imagesDeclined) return false;
  try {
    if (await chrome.permissions.contains({ origins: IMAGE_ORIGINS })) return true;
    // The prompt is modal in some environments (and cannot be answered at all in
    // headless Chrome). Never let it stall a download.
    const granted = await Promise.race([
      chrome.permissions.request({ origins: IMAGE_ORIGINS }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 10000)),
    ]);
    if (granted === 'timeout') {
      log('Image access was not answered; downloading without images.', 'error');
      return false;
    }
    if (!granted) {
      state.settings = await saveSettings({ ...state.settings, imagesDeclined: true });
      log('Image access was not granted: chapters will be saved without images.', 'error');
    }
    return granted;
  } catch (error) {
    log(`Could not request image access: ${error.message}`, 'error');
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Download view                                                       */
/* ------------------------------------------------------------------ */

function selectedChapters(row) {
  const chapters = row.volume.chapters || [];
  if (!chapters.length) return [];
  const from = Math.min(row.from, row.to);
  const to = Math.max(row.from, row.to);
  return chapters.slice(from, to + 1);
}

function updateDownloadSummary() {
  const button = $('#downloadBtn');
  const summary = $('#downloadSummary');
  if (!button || !summary) return;
  const rows = state.rows.filter((row) => row.enabled);
  const chapterCount = rows.reduce((total, row) => total + selectedChapters(row).length, 0);
  const volumeCount = rows.filter((row) => selectedChapters(row).length).length;
  summary.textContent = chapterCount
    ? `${volumeCount} volume(s), ${chapterCount} chapter(s) selected`
    : 'Nothing selected';
  button.disabled = state.busy || chapterCount === 0;
}

function renderNovel() {
  elements.novelView.replaceChildren();
  const novel = state.novel;
  if (!novel) {
    elements.novelView.classList.add('hidden');
    return;
  }
  elements.novelView.classList.remove('hidden');
  state.rows = novel.volumes.map((volume) => ({
    volume,
    enabled: true,
    from: 0,
    to: Math.max(0, volume.chapters.length - 1),
  }));

  const coverSource = (novel.volumes.find((volume) => volume.cover) || {}).cover || '';
  let cover;
  if (coverSource) {
    cover = h('img', { class: 'novel-cover', src: coverSource, alt: `${novel.name} cover` });
    cover.addEventListener('error', () => {
      cover.replaceWith(h('div', { class: 'novel-cover novel-cover-empty', text: 'No cover' }));
    });
  } else {
    cover = h('div', { class: 'novel-cover novel-cover-empty', text: 'No cover' });
  }

  const totalChapters = novel.volumes.reduce((total, volume) => total + volume.chapters.length, 0);
  const summaryText = htmlToText(novel.summaryHtml);

  const info = h('div', { class: 'novel-info' }, [
    h('h2', { text: novel.name }),
    h('p', { class: 'muted', text: novel.author ? `Author: ${novel.author}` : 'Author unknown' }),
    h('p', { class: 'muted', text: `${novel.volumes.length} volume(s) • ${totalChapters} chapter(s)` }),
    summaryText ? h('p', { class: 'novel-summary', text: summaryText }) : null,
  ]);

  const body = h('tbody');
  state.rows.forEach((row) => {
    const chapters = row.volume.chapters || [];
    const checkbox = h('input', { type: 'checkbox', class: 'checkbox', checked: row.enabled });
    checkbox.addEventListener('change', () => {
      row.enabled = checkbox.checked;
      updateDownloadSummary();
    });

    const fromSelect = h('select');
    const toSelect = h('select');
    chapters.forEach((chapter, index) => {
      fromSelect.append(h('option', { value: index, text: chapter.name }));
      toSelect.append(h('option', { value: index, text: chapter.name }));
    });
    if (!chapters.length) {
      fromSelect.disabled = true;
      toSelect.disabled = true;
      fromSelect.append(h('option', { text: 'No chapters' }));
      toSelect.append(h('option', { text: 'No chapters' }));
      checkbox.checked = false;
      row.enabled = false;
    } else {
      toSelect.value = String(chapters.length - 1);
    }

    const countCell = h('td', {
      class: 'chapter-count',
      text: chapters.length ? `${chapters.length} / ${chapters.length}` : '0',
    });

    const syncRange = () => {
      if (!chapters.length) return;
      let from = Number(fromSelect.value);
      let to = Number(toSelect.value);
      if (from > to) {
        [from, to] = [to, from];
        fromSelect.value = String(from);
        toSelect.value = String(to);
      }
      row.from = from;
      row.to = to;
      countCell.textContent = `${to - from + 1} / ${chapters.length}`;
      updateDownloadSummary();
    };
    fromSelect.addEventListener('change', syncRange);
    toSelect.addEventListener('change', syncRange);

    body.append(h('tr', {}, [
      h('td', {}, checkbox),
      h('td', { class: 'volume-name', text: row.volume.name }),
      countCell,
      h('td', {}, fromSelect),
      h('td', {}, toSelect),
    ]));
  });

  const selectAll = h('input', { type: 'checkbox', class: 'checkbox', checked: true });
  selectAll.addEventListener('change', () => {
    state.rows.forEach((row, index) => {
      if (!row.volume.chapters.length) return;
      row.enabled = selectAll.checked;
      const checkbox = body.children[index].querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = selectAll.checked;
    });
    updateDownloadSummary();
  });

  const downloadButton = h('button', { class: 'primary', id: 'downloadBtn', text: 'Download EPUB', type: 'button' });
  downloadButton.addEventListener('click', onDownloadSelected);

  const table = h('div', { class: 'table-wrap' }, h('table', {}, [
    h('thead', {}, h('tr', {}, [
      h('th'),
      h('th', { text: 'Volume' }),
      h('th', { text: 'Chapters' }),
      h('th', { text: 'From' }),
      h('th', { text: 'To' }),
    ])),
    body,
  ]));

  elements.novelView.append(h('div', { class: 'card' }, [
    h('div', { class: 'novel-card' }, [cover, info]),
    h('div', { class: 'volume-toolbar' }, [
      h('label', { class: 'row' }, [selectAll, h('span', { text: 'All volumes' })]),
      downloadButton,
      h('span', { class: 'muted', id: 'downloadSummary' }),
    ]),
    table,
  ]));
  updateDownloadSummary();
}

async function onDownloadSelected() {
  if (state.busy || !state.novel) return;
  await ensureImagePermission();
  const rows = state.rows.filter((row) => row.enabled && selectedChapters(row).length);
  if (!rows.length) {
    log('Select at least one volume with chapters first.', 'error');
    return;
  }
  const novel = state.novel;
  await runTask('Downloading volumes', async (client) => {
    for (const [index, row] of rows.entries()) {
      const chapters = selectedChapters(row);
      setProgress(0, chapters.length, `Volume ${index + 1}/${rows.length}: ${row.volume.name}`);
      log(`Downloading "${row.volume.name}" (${chapters.length} chapter(s))...`);
      const bytes = await client.makeVolumeEpub({
        novel,
        volume: row.volume,
        chapters,
        onProgress: ({ done, total, message }) => setProgress(done, total, `${row.volume.name}: ${message}`),
      });
      const relative = epubPath(novel.name, row.volume.name);
      await saveEpub(bytes, relative);
      log(`Saved ${relative} (${Math.round(bytes.length / 1024)} KB)`);
    }
    log(`${rows.length} volume(s) downloaded.`);
  });
}

async function loadNovelFromInput() {
  if (state.busy) return;
  const value = elements.novelUrl.value.trim();
  if (!value) {
    log('Enter a light novel URL first.', 'error');
    elements.novelUrl.focus();
    return;
  }
  await runTask('Loading light novel', async (client) => {
    const novel = await client.loadNovel(value);
    log(`Novel: ${novel.name} — ${novel.volumes.length} volume(s).`);
    setProgress(0, novel.volumes.length, 'Reading volumes...');
    await client.loadAllVolumes(novel, ({ done, total, message }) => setProgress(done, total, message));
    state.novel = novel;
    renderNovel();
    const withChapters = novel.volumes.filter((volume) => volume.chapters.length).length;
    log(`Chapter lists loaded for ${withChapters}/${novel.volumes.length} volume(s).`);
    if (withChapters < novel.volumes.length) {
      log('Some volumes could not be read; they are disabled in the table.', 'error');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function wireEvents() {
  elements.loadForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadNovelFromInput();
  });

  elements.cancelBtn.addEventListener('click', () => {
    if (state.activeClient) state.activeClient.cancel();
  });

  elements.clearLogBtn.addEventListener('click', () => {
    elements.log.replaceChildren();
  });
}

async function init() {
  state.settings = await loadSettings();

  elements.versionBadge.textContent = `v${TOOL_VERSION}`;
  wireEvents();
  document.documentElement.dataset.ready = 'true';

  const params = new URLSearchParams(location.search);
  const initialUrl = params.get('url');
  if (initialUrl) {
    elements.novelUrl.value = initialUrl;
    loadNovelFromInput();
  }
}

init();
