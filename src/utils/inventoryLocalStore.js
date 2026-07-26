const INVENTORY_DB = "wowloot-inventory";
const INVENTORY_STORE = "items";
const INVENTORY_KEY = "inventory-items";
const INVENTORY_META_KEY = "inventory-meta";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INVENTORY_DB, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INVENTORY_STORE)) {
        db.createObjectStore(INVENTORY_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveInventoryItems(items, meta = {}) {
  const db = await openDb();
  const safeMeta = meta && typeof meta === "object" ? meta : {};
  await new Promise((resolve, reject) => {
    const tx = db.transaction(INVENTORY_STORE, "readwrite");
    tx.objectStore(INVENTORY_STORE).put(items, INVENTORY_KEY);
    tx.objectStore(INVENTORY_STORE).put(
      {
        syncedAt: new Date().toISOString(),
        count: items.length,
        ...safeMeta
      },
      INVENTORY_META_KEY
    );
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadInventoryItems() {
  if (!window.indexedDB) {
    return [];
  }

  const db = await openDb();
  const items = await new Promise((resolve, reject) => {
    const tx = db.transaction(INVENTORY_STORE, "readonly");
    const req = tx.objectStore(INVENTORY_STORE).get(INVENTORY_KEY);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items;
}

export async function clearInventoryItems() {
  if (!window.indexedDB) {
    return;
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(INVENTORY_STORE, "readwrite");
    tx.objectStore(INVENTORY_STORE).delete(INVENTORY_KEY);
    tx.objectStore(INVENTORY_STORE).delete(INVENTORY_META_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadInventoryMeta() {
  if (!window.indexedDB) {
    return null;
  }

  const db = await openDb();
  const meta = await new Promise((resolve, reject) => {
    const tx = db.transaction(INVENTORY_STORE, "readonly");
    const req = tx.objectStore(INVENTORY_STORE).get(INVENTORY_META_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return meta;
}

export const INVENTORY_UPDATED_EVENT = "wowloot-inventory-updated";

export function dispatchInventoryUpdated() {
  window.dispatchEvent(new Event(INVENTORY_UPDATED_EVENT));
}
