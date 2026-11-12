// Settings persistence. The download-only UI needs the save folder, the speed
// mode and whether image access was declined; nothing else is stored.

const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  mode: 'slow',
  folder: 'hako2epub',
  imagesDeclined: false,
};

/** Keep the downloads subfolder a plain relative path. */
export function sanitizeFolder(value) {
  const cleaned = String(value || '')
    .replace(/[\\:*?"<>|]/g, '')
    .replace(/\.{2,}/g, '')
    .replace(/[/\\]{2,}/g, '/')
    .replace(/^[/\\]+|[/\\]+$/g, '')
    .trim();
  return cleaned || DEFAULT_SETTINGS.folder;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = isPlainObject(stored[SETTINGS_KEY]) ? stored[SETTINGS_KEY] : {};
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    mode: value.mode === 'fast' ? 'fast' : 'slow',
    folder: sanitizeFolder(value.folder),
  };
}

export async function saveSettings(settings) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...settings,
    folder: sanitizeFolder(settings.folder),
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
