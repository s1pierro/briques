// ─── IndexedDB key-value store ────────────────────────────────────────────────
//
// Store léger pour les données volumineuses (OBJ pré-calculés, etc.)
// qui ne tiennent pas dans le quota localStorage (~5 Mo).
//
// Usage :
//   import { idb } from './idb-store.js';
//   await idb.set('brick:br-xxx:geoMedium', objText);
//   const obj = await idb.get('brick:br-xxx:geoMedium');

const DB_NAME    = 'rbang_db';
const DB_VERSION = 1;
const STORE      = 'blobs';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(mode) {
  return openDB().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export const idb = {

  /** Lire une valeur par clé. Retourne undefined si absente. */
  async get(key) {
    return wrap((await tx('readonly')).get(key));
  },

  /** Écrire une valeur (string, ArrayBuffer, Blob, …). */
  async set(key, value) {
    return wrap((await tx('readwrite')).put(value, key));
  },

  /** Supprimer une clé. */
  async del(key) {
    return wrap((await tx('readwrite')).delete(key));
  },

  /** Lister toutes les clés (optionnel : filtrées par préfixe). */
  async keys(prefix) {
    const all = await wrap((await tx('readonly')).getAllKeys());
    return prefix ? all.filter(k => typeof k === 'string' && k.startsWith(prefix)) : all;
  },

  /** Lire plusieurs clés d'un coup. Retourne un Map<key, value>. */
  async getMany(keys) {
    const store = await tx('readonly');
    const entries = await Promise.all(keys.map(k => wrap(store.get(k)).then(v => [k, v])));
    return new Map(entries.filter(([, v]) => v !== undefined));
  },

  /** Écrire plusieurs clés d'un coup. */
  async setMany(entries) {
    const store = await tx('readwrite');
    await Promise.all(entries.map(([k, v]) => wrap(store.put(v, k))));
  },

  /** Supprimer toutes les clés avec un préfixe donné. */
  async delPrefix(prefix) {
    const ks = await this.keys(prefix);
    if (!ks.length) return;
    const store = await tx('readwrite');
    await Promise.all(ks.map(k => wrap(store.delete(k))));
  },
};
