// Service worker: opens the in-page panel from the toolbar button or the
// context menu. It never creates a tab; the UI lives inside the site page.

const SUPPORTED_DOMAINS = ['ln.hako.vn', 'docln.net', 'docln.sbs'];
const DOMAIN_PATTERNS = SUPPORTED_DOMAINS.map((domain) => `*://${domain}/*`);

function isSupportedPage(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return SUPPORTED_DOMAINS.includes(host);
  } catch {
    return false;
  }
}

/**
 * Ask the content script in `tab` to open its panel. Returns false when the tab
 * is not a supported novel page, or when no content script is listening.
 */
async function openPanel(tab, url) {
  const target = tab && Number.isFinite(tab.id)
    ? tab
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target || !Number.isFinite(target.id)) return false;
  const pageUrl = url || target.url || '';
  if (!isSupportedPage(pageUrl)) return false;
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'hako2epub:open', url: pageUrl });
    return true;
  } catch {
    // No content script in that tab (not a novel page): stay silent rather than
    // opening a separate tab.
    return false;
  }
}

chrome.action.onClicked.addListener((tab) => {
  openPanel(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'hako2epub-page',
      title: 'Download this light novel with hako2epub',
      contexts: ['page'],
      documentUrlPatterns: DOMAIN_PATTERNS,
    });
    chrome.contextMenus.create({
      id: 'hako2epub-link',
      title: 'Download with hako2epub',
      contexts: ['link'],
      targetUrlPatterns: DOMAIN_PATTERNS,
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'hako2epub-page' && info.menuItemId !== 'hako2epub-link') return;
  openPanel(tab, info.linkUrl || info.pageUrl || '');
});
