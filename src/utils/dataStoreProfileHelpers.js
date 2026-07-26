function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function hasAnyMarker(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

function profileKey(name, realm) {
  return `${normalize(name)}|${normalize(realm)}`;
}

export function detectDataStoreSourceType(fileName, text) {
  const name = normalize(fileName);
  const body = String(text || "");

  if (name === "datastore.lua") {
    return "core";
  }

  if (name.includes("datastore_containers")) {
    return "containers";
  }
  if (name.includes("datastore_inventory")) {
    return "inventory";
  }
  if (name.includes("datastore_characters")) {
    return "characters";
  }

  if (hasAnyMarker(body, ["DataStore_ContainersDB", "DataStore_Containers_Characters"])) {
    return "containers";
  }
  if (hasAnyMarker(body, ["DataStore_InventoryDB", "DataStore_Inventory_Characters"])) {
    return "inventory";
  }
  if (hasAnyMarker(body, ["DataStore_CharactersDB", "DataStore_Characters_Characters"])) {
    return "characters";
  }

  return "unknown";
}

function parseCharacterReference(reference) {
  const match = String(reference || "").match(/^Default\.([^\.]+)\.(.+)$/);
  if (!match) {
    return null;
  }

  return {
    realm: match[1],
    name: match[2]
  };
}

export function parseDataStoreCharacterIndexMap(luaText) {
  const body = String(luaText || "");
  const byIndex = new Map();

  const listMatch = body.match(/DataStore_CharacterIDs\s*=\s*\{[\s\S]*?\["List"\]\s*=\s*\{([\s\S]*?)\}\s*,?[\s\S]*?\}/);
  if (listMatch) {
    const listBlock = listMatch[1];
    const regex = /"([^"\n\r]+)"/g;
    let match;
    let index = 1;
    while ((match = regex.exec(listBlock)) !== null) {
      const parsed = parseCharacterReference(match[1]);
      if (parsed) {
        byIndex.set(index, parsed);
      }
      index += 1;
    }
  }

  if (!byIndex.size) {
    const setBlockMatch = body.match(/DataStore_CharacterIDs\s*=\s*\{[\s\S]*?\["Set"\]\s*=\s*\{([\s\S]*?)\}\s*,?[\s\S]*?\}/);
    if (setBlockMatch) {
      const setBlock = setBlockMatch[1];
      const regex = /\["(Default\.[^"]+)"\]\s*=\s*(\d+)/g;
      let match;
      while ((match = regex.exec(setBlock)) !== null) {
        const parsed = parseCharacterReference(match[1]);
        const index = Number(match[2]);
        if (parsed && Number.isInteger(index) && index > 0) {
          byIndex.set(index, parsed);
        }
      }
    }
  }

  return byIndex;
}

export function mergeInventoryProfiles(entries) {
  const byKey = new Map();

  entries.forEach((entry) => {
    const key = profileKey(entry.characterName, entry.realm);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, entry);
      return;
    }

    const existingStamp = Number(existing.lastInventoryUpdate || 0);
    const incomingStamp = Number(entry.lastInventoryUpdate || 0);
    if (incomingStamp >= existingStamp) {
      byKey.set(key, entry);
    }
  });

  return [...byKey.values()];
}

export function mergeCharacterProfiles(entries) {
  const byKey = new Map();

  entries.forEach((entry) => {
    const key = profileKey(entry.characterName, entry.realm);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, entry);
      return;
    }

    const existingStamp = Number(existing.lastCharacterUpdate || existing.lastLogoutTimestamp || 0);
    const incomingStamp = Number(entry.lastCharacterUpdate || entry.lastLogoutTimestamp || 0);
    if (incomingStamp >= existingStamp) {
      byKey.set(key, entry);
    }
  });

  return [...byKey.values()];
}

export function characterProfileKey(name, realm) {
  return profileKey(name, realm);
}
