import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  writeBatch,
  where
} from "firebase/firestore";
import { db } from "./firebase";
import { saveInventoryItems } from "../utils/inventoryLocalStore";
import { dispatchInventoryUpdated } from "../utils/inventoryLocalStore";

const COLLECTIONS = {
  accounts: "accounts",
  characters: "characters",
  raidStatuses: "raidStatuses",
  lootItems: "lootItems",
  shoppingProfiles: "shoppingProfiles",
  buffProfiles: "buffProfiles"
};
const INVENTORY_SNAPSHOTS = "inventorySnapshots";

export function subscribeUserCollection(collectionName, uid, callback) {
  if (!db || !uid) {
    callback([]);
    return () => {};
  }

  const q = query(collection(db, collectionName), where("userId", "==", uid));

  return onSnapshot(q, (snapshot) => {
    const docs = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    callback(docs);
  });
}

export function subscribeAllCollection(collectionName, callback) {
  if (!db) {
    callback([]);
    return () => {};
  }

  return onSnapshot(collection(db, collectionName), (snapshot) => {
    const docs = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    callback(docs);
  });
}

export function addAccount(uid, battleNetId) {
  return addDoc(collection(db, COLLECTIONS.accounts), {
    userId: uid,
    battleNetId,
    createdAt: new Date().toISOString()
  });
}

export function addCharacter(uid, payload) {
  return addDoc(collection(db, COLLECTIONS.characters), {
    userId: uid,
    ...payload,
    createdAt: new Date().toISOString()
  });
}

export function updateCharacter(characterId, payload) {
  return updateDoc(doc(db, COLLECTIONS.characters, characterId), payload);
}

export function deleteCharacter(characterId) {
  return deleteDoc(doc(db, COLLECTIONS.characters, characterId));
}

export function upsertRaidStatus(uid, payload) {
  const raidKey = payload.raidName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const docId = `${uid}-${payload.characterId}-${raidKey}`;

  return setDoc(doc(db, COLLECTIONS.raidStatuses, docId), {
    userId: uid,
    ...payload,
    updatedAt: new Date().toISOString()
  });
}

export function addLootItem(uid, payload) {
  return addDoc(collection(db, COLLECTIONS.lootItems), {
    userId: uid,
    ...payload,
    createdAt: new Date().toISOString()
  });
}

export function updateLootItem(lootId, payload) {
  return updateDoc(doc(db, COLLECTIONS.lootItems, lootId), payload);
}

export function deleteLootItem(lootId) {
  return deleteDoc(doc(db, COLLECTIONS.lootItems, lootId));
}

export function addShoppingProfile(uid, payload) {
  return addDoc(collection(db, COLLECTIONS.shoppingProfiles), {
    userId: uid,
    ...payload,
    createdAt: new Date().toISOString()
  });
}

export function updateShoppingProfile(profileId, payload) {
  return updateDoc(doc(db, COLLECTIONS.shoppingProfiles, profileId), payload);
}

export function deleteShoppingProfile(profileId) {
  return deleteDoc(doc(db, COLLECTIONS.shoppingProfiles, profileId));
}

export function addBuffProfile(uid, payload) {
  return addDoc(collection(db, COLLECTIONS.buffProfiles), {
    userId: uid,
    ...payload,
    createdAt: new Date().toISOString()
  });
}

export function updateBuffProfile(profileId, payload) {
  return updateDoc(doc(db, COLLECTIONS.buffProfiles, profileId), payload);
}

export function deleteBuffProfile(profileId) {
  return deleteDoc(doc(db, COLLECTIONS.buffProfiles, profileId));
}

export function subscribeInventorySnapshot(uid, callback) {
  if (!uid || !db) {
    callback([]);
    return () => {};
  }

  return onSnapshot(doc(db, INVENTORY_SNAPSHOTS, uid), async (snapshot) => {
    const snapshotData = snapshot.exists() ? snapshot.data() : null;
    const items = snapshotData && Array.isArray(snapshotData.items)
      ? snapshotData.items
      : [];
    const meta = snapshotData && typeof snapshotData.meta === "object" ? snapshotData.meta : {};

    await saveInventoryItems(items, meta);
    callback(items);
    dispatchInventoryUpdated();
  });
}

export async function replaceInventoryItems(uid, items, meta = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeMeta = meta && typeof meta === "object" ? meta : {};

  if (db && uid) {
    await setDoc(doc(db, INVENTORY_SNAPSHOTS, uid), {
      userId: uid,
      items: safeItems,
      meta: safeMeta,
      updatedAt: new Date().toISOString()
    });
  }

  await saveInventoryItems(safeItems, safeMeta);
  dispatchInventoryUpdated();
}

export async function clearInventoryData(uid) {
  if (db && uid) {
    await deleteDoc(doc(db, INVENTORY_SNAPSHOTS, uid));
  }

  await saveInventoryItems([]);
  dispatchInventoryUpdated();
}

export async function deleteAllUserData(uid) {
  if (!db || !uid) {
    return;
  }

  const names = Object.values(COLLECTIONS);
  const snapshots = await Promise.all(
    names.map((name) => getDocs(query(collection(db, name), where("userId", "==", uid))))
  );

  let batch = writeBatch(db);
  let opCount = 0;

  for (const snapshot of snapshots) {
    for (const item of snapshot.docs) {
      batch.delete(item.ref);
      opCount += 1;

      if (opCount === 450) {
        await batch.commit();
        batch = writeBatch(db);
        opCount = 0;
      }
    }
  }

  if (opCount > 0) {
    await batch.commit();
  }

  await deleteDoc(doc(db, INVENTORY_SNAPSHOTS, uid));
}

export { COLLECTIONS };
