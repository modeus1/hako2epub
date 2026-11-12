/**
 * Persistent chapter cache backed by IndexedDB.
 *
 * Long novels (hundreds of chapters) take many minutes to download and are
 * rate-limited by the site, so a completed chapter is kept on disk and reused
 * on the next run instead of being fetched again. Everything degrades to a
 * no-op when IndexedDB is unavailable (e.g. the Node test environment).
 */

const DB_NAME = 'hako2epub-chapters';
const DB_VERSION = 1;
const STORE = 'chapters';

/**
 * Cache key for a chapter URL. Only the path is used so the same chapter is
 * recognised across the rotating mirrors (ln.hako.vn, docln.net, docln.sbs).
 */
export function cacheKey(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url);
  }
}

// Chapters already rendered in this tab stay in RAM, so a repeat download
// inside one session never touches IndexedDB or the network. Bounded so a
// long browsing session cannot grow without limit.
const MEMORY_LIMIT = 400;
const memory = new Map();

function remember(key, record) {
  if (memory.has(key)) memory.delete(key);
  memory.set(key, record);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

let dbPromise = null;

function openDb() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

async function withStore(mode, action) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, mode);
    } catch {
      resolve(null);
      return;
    }
    const store = transaction.objectStore(STORE);
    let result = null;
    try {
      const request = action(store);
      if (request) request.onsuccess = () => { result = request.result; };
    } catch {
      resolve(null);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => resolve(null);
    transaction.onabort = () => resolve(null);
  });
}

export const chapterCache = {
  /**
   * @returns {Promise<null | {title: string, xhtml: string, images: Array<{path: string, mime: string, data: Uint8Array}>, savedAt: number}>}
   */
  async get(url) {
    const key = cacheKey(url);
    const inMemory = memory.get(key);
    if (inMemory) return inMemory;
    const record = await withStore('readonly', (store) => store.get(key));
    if (!record || typeof record.xhtml !== 'string' || !record.xhtml) return null;
    remember(key, record);
    return record;
  },

  /** Store a rendered chapter; failures are swallowed so downloads keep going. */
  async put(url, chapter) {
    if (!chapter || typeof chapter.xhtml !== 'string') return false;
    const record = {
      title: chapter.title || '',
      xhtml: chapter.xhtml,
      images: Array.isArray(chapter.images)
        ? chapter.images.map((image) => ({ path: image.path, mime: image.mime, data: image.data }))
        : [],
      savedAt: Date.now(),
    };
    const key = cacheKey(url);
    remember(key, record);
    const done = await withStore('readwrite', (store) => store.put(record, key));
    return done !== null;
  },

  async remove(url) {
    const key = cacheKey(url);
    memory.delete(key);
    return (await withStore('readwrite', (store) => store.delete(key))) !== null;
  },

  async count() {
    const total = await withStore('readonly', (store) => store.count());
    return typeof total === 'number' ? total : 0;
  },

  async clear() {
    memory.clear();
    return (await withStore('readwrite', (store) => store.clear())) !== null;
  },

  /** Chapters currently held in RAM (dropped when the page is closed). */
  stats() {
    return { memory: memory.size, memoryLimit: MEMORY_LIMIT };
  },
};
