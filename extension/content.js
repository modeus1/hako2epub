/**
 * In-page launcher: adds a "Download EPUB" button to novel pages on the
 * supported sites and opens the extension's own UI in a side panel, so the
 * download is started from the page you are already reading. The toolbar icon
 * and the context menu open the same panel; the extension never opens a tab.
 *
 * This is a classic content script (MV3 content scripts cannot be ES modules),
 * so it contains no download logic: the panel is an iframe of app.html, which
 * receives the novel URL and loads it exactly like a pasted URL.
 */
(() => {
  'use strict';

  // Only the top document, and never twice (some sites re-render <body>).
  if (window.top !== window) return;
  if (document.getElementById('hako2epub-launcher')) return;

  const LAUNCHER_ID = 'hako2epub-launcher';
  const PANEL_ID = 'hako2epub-panel';
  // A novel page is /<kind>/<id>-<slug>; chapter pages have a third segment.
  const isNovelPage = /^\/[a-z-]+\/\d+-[^/]+\/?$/.test(location.pathname);

  const iconUrl = chrome.runtime.getURL('icons/icon32.png');
  const panelUrlFor = (url) => `${chrome.runtime.getURL('app.html')}?url=${encodeURIComponent(url)}`;

  function injectStyles() {
    if (document.getElementById('hako2epub-style')) return;
    const style = document.createElement('style');
    style.id = 'hako2epub-style';
    style.textContent = `
      #${LAUNCHER_ID} {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
        display: flex; align-items: center; gap: 8px; padding: 10px 16px 10px 12px;
        border: 0; border-radius: 999px; background: #1aa892; color: #fff;
        font: 600 14px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25); cursor: pointer;
      }
      #${LAUNCHER_ID}:hover { background: #148a78; }
      #${LAUNCHER_ID} img { width: 20px; height: 20px; border-radius: 5px; display: block; }
      #${PANEL_ID} {
        position: fixed; inset: 0; z-index: 2147483647; display: flex; justify-content: flex-end;
        background: rgba(10, 20, 25, 0.45);
      }
      #${PANEL_ID}[hidden] { display: none; }
      #${PANEL_ID} .hako2epub-sheet {
        position: relative; width: min(580px, 100%); height: 100%; background: #fff;
        box-shadow: -8px 0 30px rgba(0, 0, 0, 0.3);
      }
      #${PANEL_ID} iframe { width: 100%; height: 100%; border: 0; display: block; }
      #hako2epub-close {
        position: absolute; top: 10px; right: 12px; z-index: 1; width: 30px; height: 30px;
        border: 0; border-radius: 50%; background: rgba(0, 0, 0, 0.55); color: #fff;
        font: 600 15px/1 system-ui, sans-serif; cursor: pointer;
      }
      #hako2epub-close:hover { background: rgba(0, 0, 0, 0.75); }
      @media (max-width: 600px) { #${PANEL_ID} .hako2epub-sheet { width: 100%; } }
    `;
    document.documentElement.append(style);
  }

  let panel = null;

  function closePanel() {
    if (panel) panel.hidden = true;
  }

  function buildPanel(url) {
    const wrapper = document.createElement('div');
    wrapper.id = PANEL_ID;
    wrapper.hidden = true;

    const sheet = document.createElement('div');
    sheet.className = 'hako2epub-sheet';

    const close = document.createElement('button');
    close.id = 'hako2epub-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '\u2715';
    close.addEventListener('click', closePanel);

    const frame = document.createElement('iframe');
    frame.title = 'hako2epub';
    frame.src = panelUrlFor(url);

    sheet.append(close, frame);
    wrapper.append(sheet);
    wrapper.addEventListener('click', (event) => {
      if (event.target === wrapper) closePanel();
    });

    document.documentElement.append(wrapper);
    return wrapper;
  }

  /** Show the panel for `url` (defaults to the page being viewed). */
  function openPanel(url = location.href) {
    injectStyles();
    if (!panel) {
      panel = buildPanel(url);
    } else {
      const frame = panel.querySelector('iframe');
      const wanted = panelUrlFor(url);
      if (frame && frame.src !== wanted) frame.src = wanted;
    }
    panel.hidden = false;
  }

  function addLauncher() {
    if (document.getElementById(LAUNCHER_ID)) return;
    injectStyles();
    const button = document.createElement('button');
    button.id = LAUNCHER_ID;
    button.type = 'button';
    button.title = 'Download this novel as EPUB';
    const icon = document.createElement('img');
    icon.src = iconUrl;
    icon.alt = '';
    button.append(icon, document.createTextNode('Download EPUB'));
    button.addEventListener('click', () => openPanel());
    document.documentElement.append(button);
  }

  // The toolbar icon and context menu ask the page to show the panel.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'hako2epub:open') return undefined;
    openPanel(typeof message.url === 'string' && message.url ? message.url : location.href);
    sendResponse({ opened: true });
    return undefined;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });

  if (isNovelPage) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', addLauncher, { once: true });
    } else {
      addLauncher();
    }
  }
})();
