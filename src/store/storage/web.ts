/**
 * Web 向け BinaryStorage 実装（IndexedDB）。
 * - DB: `wall-maker`、ストア: `binaries`、キー: 任意 string、値: Uint8Array。
 * - 自前実装（追加 dep を入れない方針、第7.2章の趣旨）。
 */

import type { BinaryStorage } from './types';

const DB_NAME = 'wall-maker';
const DB_VERSION = 1;
const STORE_NAME = 'binaries';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function awaitReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

export class WebBinaryStorage implements BinaryStorage {
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const db = await openDb();
    await awaitReq(tx(db, 'readwrite').put(bytes, key));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const db = await openDb();
    const value = await awaitReq<unknown>(tx(db, 'readonly').get(key));
    if (value === undefined) return null;
    if (value instanceof Uint8Array) return value;
    // 古いブラウザが ArrayBuffer で返すケースに保険
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new Error(
      `WebBinaryStorage.get: unexpected value type for key "${key}"`,
    );
  }

  async delete(key: string): Promise<void> {
    const db = await openDb();
    await awaitReq(tx(db, 'readwrite').delete(key));
  }

  async keys(): Promise<string[]> {
    const db = await openDb();
    const result = await awaitReq<IDBValidKey[]>(
      tx(db, 'readonly').getAllKeys(),
    );
    return result.map((k) => String(k));
  }
}
