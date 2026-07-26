function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function hasAnyMarker(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

export function validateNovaSourceHealth({
  fileName = "",
  text = "",
  parsedCharactersCount = 0,
  parsedSavedCount = 0,
  parsedWorldBuffCount = 0
}) {
  const warnings = [];
  const name = normalize(fileName);
  const body = String(text || "");

  const looksLikeTracker = name.includes("novainstancetracker")
    || hasAnyMarker(body, ["savedInstances", "instanceName", "myChars"]);
  const looksLikeWorldBuffs = name.includes("novaworldbuffs")
    || hasAnyMarker(body, ["storedBuffs", "chronoCount", "onyCount", "nefCount"]);

  if (looksLikeTracker) {
    const hasStructure = hasAnyMarker(body, ["savedInstances", "myChars"]);
    if (hasStructure && parsedCharactersCount === 0 && parsedSavedCount === 0) {
      warnings.push("file structure looks valid, but no characters or raid lockouts were parsed");
    }
  }

  if (looksLikeWorldBuffs) {
    const hasStructure = hasAnyMarker(body, ["storedBuffs", "chronoCount", "onyCount", "nefCount"]);
    if (hasStructure && parsedWorldBuffCount === 0) {
      warnings.push("world buff markers were found, but no buff snapshots were parsed");
    }
  }

  if (!looksLikeTracker && !looksLikeWorldBuffs && parsedCharactersCount === 0 && parsedSavedCount === 0 && parsedWorldBuffCount === 0) {
    warnings.push("file was not recognized as Nova data and yielded no parsed records");
  }

  return warnings.map((warning) => `${fileName || "Unknown Nova file"}: ${warning}`);
}

export function validateDataStoreSourceHealth({
  fileName = "",
  text = "",
  sourceType = "unknown",
  parsedCount = 0
}) {
  const warnings = [];
  const body = String(text || "");
  const label = fileName || "Unknown DataStore file";
  const looksLikeAddonSource = body.includes("DataStore:RegisterModule")
    || body.includes("local addonName")
    || body.includes("## Interface");

  if (sourceType === "core") {
    return warnings;
  }

  if (sourceType === "containers") {
    const hasMarker = body.includes("DataStore_ContainersDB")
      || body.includes("DataStore_Containers_Characters");
    if (!hasMarker) {
      warnings.push(`${label}: missing DataStore containers markers (try WTF/Account/<account>/SavedVariables/DataStore_Containers.lua)`);
      if (looksLikeAddonSource) {
        warnings.push(`${label}: this looks like AddOns source code, not SavedVariables character data`);
      }
    } else if (parsedCount === 0) {
      warnings.push(`${label}: containers DB detected, but no inventory item stacks were parsed`);
    }
    return warnings;
  }

  if (sourceType === "inventory") {
    const hasMarker = body.includes("DataStore_InventoryDB")
      || body.includes("DataStore_Inventory_Characters");
    if (!hasMarker) {
      warnings.push(`${label}: missing DataStore inventory markers (try WTF/Account/<account>/SavedVariables/DataStore_Inventory.lua)`);
      if (looksLikeAddonSource) {
        warnings.push(`${label}: this looks like AddOns source code, not SavedVariables character data`);
      }
    } else if (parsedCount === 0) {
      warnings.push(`${label}: inventory DB detected, but no gear profiles were parsed`);
    }
    return warnings;
  }

  if (sourceType === "characters") {
    const hasMarker = body.includes("DataStore_CharactersDB")
      || body.includes("DataStore_Characters_Characters")
      || body.includes("DataStore_Characters_Info");
    if (!hasMarker) {
      warnings.push(`${label}: missing DataStore characters markers (try WTF/Account/<account>/SavedVariables/DataStore_Characters.lua)`);
      if (looksLikeAddonSource) {
        warnings.push(`${label}: this looks like AddOns source code, not SavedVariables character data`);
      }
    } else if (parsedCount === 0) {
      warnings.push(`${label}: characters DB detected, but no character profiles were parsed`);
    }
    return warnings;
  }

  warnings.push(`${label}: file type was not recognized as DataStore_Containers, DataStore_Inventory, or DataStore_Characters`);
  return warnings;
}

export function formatImportWarnings(warnings, maxItems = 2) {
  const uniqueWarnings = Array.from(new Set((warnings || []).filter(Boolean)));
  if (!uniqueWarnings.length) {
    return "";
  }

  const preview = uniqueWarnings.slice(0, maxItems).join(" | ");
  const remaining = uniqueWarnings.length - maxItems;
  return remaining > 0 ? `${preview} (+${remaining} more)` : preview;
}