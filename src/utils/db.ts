import { AppConfig, Source, Stream, Group, Settings } from '../types';

const DB_NAME = 'JashAddonDB';
const DB_VERSION = 1;
const STORES = {
  sources: 'sources',
  streams: 'streams',
  groups: 'groups',
  settings: 'settings',
};

let db: IDBDatabase | null = null;

export async function openDB(): Promise<IDBDatabase> {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = (e.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORES.sources)) {
        database.createObjectStore(STORES.sources, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.streams)) {
        const streamStore = database.createObjectStore(STORES.streams, { keyPath: 'id' });
        streamStore.createIndex('sourceId', 'sourceId', { unique: false });
        streamStore.createIndex('group', 'group', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORES.groups)) {
        database.createObjectStore(STORES.groups, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.settings)) {
        database.createObjectStore(STORES.settings, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

async function getStore(storeName: string, mode: IDBTransactionMode = 'readonly') {
  const database = await openDB();
  return database.transaction(storeName, mode).objectStore(storeName);
}

async function getAll<T>(storeName: string): Promise<T[]> {
  const store = await getStore(storeName);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

async function putItem<T>(storeName: string, item: T): Promise<void> {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteItem(storeName: string, id: string): Promise<void> {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function clearStore(storeName: string): Promise<void> {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Sources
export const sourcesDB = {
  getAll: () => getAll<Source>(STORES.sources),
  put: (s: Source) => putItem(STORES.sources, s),
  delete: (id: string) => deleteItem(STORES.sources, id),
  clear: () => clearStore(STORES.sources),
};

// Streams
export const streamsDB = {
  getAll: () => getAll<Stream>(STORES.streams),
  put: (s: Stream) => putItem(STORES.streams, s),
  delete: (id: string) => deleteItem(STORES.streams, id),
  clear: () => clearStore(STORES.streams),
  bulkPut: async (streams: Stream[]) => {
    const database = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORES.streams, 'readwrite');
      const store = tx.objectStore(STORES.streams);
      streams.forEach(s => store.put(s));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  bulkDelete: async (ids: string[]) => {
    const database = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORES.streams, 'readwrite');
      const store = tx.objectStore(STORES.streams);
      ids.forEach(id => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  deleteBySource: async (sourceId: string) => {
    const database = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORES.streams, 'readwrite');
      const store = tx.objectStore(STORES.streams);
      const idx = store.index('sourceId');
      const req = idx.openCursor(IDBKeyRange.only(sourceId));
      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// Groups
export const groupsDB = {
  getAll: () => getAll<Group>(STORES.groups),
  put: (g: Group) => putItem(STORES.groups, g),
  delete: (id: string) => deleteItem(STORES.groups, id),
  clear: () => clearStore(STORES.groups),
};

// Settings
const SETTINGS_ID = 'global';
export const settingsDB = {
  get: async (): Promise<Settings> => {
    const store = await getStore(STORES.settings);
    return new Promise((resolve, reject) => {
      const req = store.get(SETTINGS_ID);
      req.onsuccess = () => resolve(req.result?.data || getDefaultSettings());
      req.onerror = () => reject(req.error);
    });
  },
  put: async (s: Settings) => {
    const store = await getStore(STORES.settings, 'readwrite');
    return new Promise<void>((resolve, reject) => {
      const req = store.put({ id: SETTINGS_ID, data: s });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
};

export function getDefaultSettings(): Settings {
  return {
    addonId             : 'jash-iptv-addon',
    addonName           : 'Jash IPTV',
    corsProxy           : 'https://corsproxy.io/?',
    autoRemoveDead      : false,
    combineByGroups     : true,
    combineMultiQuality : true,
    sortAlphabetically  : true,
    healthCheckInterval : 60,
  };
}

// Export/Import
export async function exportConfig(): Promise<AppConfig> {
  const [sources, streams, groups, settings] = await Promise.all([
    sourcesDB.getAll(),
    streamsDB.getAll(),
    groupsDB.getAll(),
    settingsDB.get(),
  ]);
  return { sources, streams, groups, settings };
}

export async function importConfig(config: AppConfig): Promise<void> {
  await Promise.all([
    sourcesDB.clear(),
    streamsDB.clear(),
    groupsDB.clear(),
  ]);
  await Promise.all([
    ...config.sources.map(s => sourcesDB.put(s)),
    ...config.groups.map(g => groupsDB.put(g)),
    settingsDB.put(config.settings),
  ]);
  await streamsDB.bulkPut(config.streams);
}
