import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { RAIDS } from "../data/raids";
import { useUserCollections } from "../hooks/useUserCollections";
import {
  addAccount,
  addCharacter,
  clearInventoryData,
  deleteAllUserData,
  replaceInventoryItems,
  updateCharacter,
  upsertRaidStatus
} from "../services/dataService";
import {
  parseNovaActiveInstances,
  parseNovaCharacters,
  parseNovaSavedInstances,
  parseNovaWorldBuffs
} from "../utils/novaInstanceParser";
import {
  buildConnectedFileEntries,
  loadConnectedHandles,
  mergeConnectedHandles,
  readConnectedFileMeta,
  saveConnectedFileMeta,
  saveConnectedHandles
} from "../utils/novaFileConnections";
import { parseDataStoreContainers } from "../utils/dataStoreContainersParser";
import { parseDataStoreInventory } from "../utils/dataStoreInventoryParser";
import { parseDataStoreCharacters } from "../utils/dataStoreCharactersParser";
import {
  characterProfileKey,
  detectDataStoreSourceType,
  parseDataStoreCharacterIndexMap,
  mergeCharacterProfiles,
  mergeInventoryProfiles
} from "../utils/dataStoreProfileHelpers";
import {
  formatImportWarnings,
  validateDataStoreSourceHealth,
  validateNovaSourceHealth
} from "../utils/importHealthChecks";
import {
  buildConnectedFileEntries as buildBagnonConnectedFileEntries,
  loadConnectedHandles as loadBagnonConnectedHandles,
  mergeConnectedHandles as mergeBagnonConnectedHandles,
  readConnectedFileMeta as readBagnonConnectedFileMeta,
  saveConnectedFileMeta as saveBagnonConnectedFileMeta,
  saveConnectedHandles as saveBagnonConnectedHandles
} from "../utils/bagnonFileConnections";
import { getCharacterFilterOptions, matchesCharacterFilters, resolveRaidTagLabel } from "../utils/characterFilters";

const NIT_PATHS_KEY = "nit_savedvariables_paths";
const NIT_SELECTED_FILE_INDEXES_KEY = "nit_selected_file_indexes";
const BAGNON_PATHS_KEY = "bagnon_savedvariables_paths";
const BAGNON_SELECTED_FILE_INDEXES_KEY = "bagnon_selected_file_indexes";
const NOVA_SYNC_ACCOUNT_FILTERS_KEY = "nit_sync_account_filters";
const INVENTORY_SYNC_ACCOUNT_FILTERS_KEY = "inventory_sync_account_filters";
const INVENTORY_SYNC_HISTORY_KEY = "inventory_sync_history_by_account";
const NOVA_EXPECTED_FILES = ["NovaInstanceTracker.lua", "NovaWorldBuffs.lua"];
const INVENTORY_EXPECTED_FILES = [
  "DataStore_Containers.lua",
  "DataStore_Inventory.lua",
  "DataStore_Characters.lua",
  "DataStore.lua"
];

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function characterKey(name, realm) {
  return `${normalize(name)}|${normalize(realm)}`;
}

function normalizeLoose(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function characterLooseKey(name, realm) {
  return `${normalizeLoose(name)}|${normalizeLoose(realm)}`;
}

function extractAccountFromPath(path) {
  const match = String(path || "").match(/[\\/]Account[\\/]([^\\/]+)[\\/]SavedVariables/i);
  return match?.[1] || "";
}

function getUniqueAccountHint(paths) {
  const accounts = Array.from(
    new Set(paths.map((path) => extractAccountFromPath(path)).filter(Boolean))
  );
  return accounts.length === 1 ? accounts[0] : "";
}

function getFileLabelHint(paths) {
  const labels = Array.from(new Set(paths.map((path) => String(path || "").trim()).filter(Boolean)));
  return labels.length === 1 ? labels[0] : "";
}

function getDefaultAccountLabel(accounts, userEmail) {
  if (Array.isArray(accounts) && accounts.length === 1) {
    return String(accounts[0]?.battleNetId || "").trim();
  }

  const emailLocalPart = String(userEmail || "").split("@")[0]?.trim();
  return emailLocalPart || "";
}

function summarizeLinkedFiles(files, expectedFiles) {
  const linkedNames = files
    .map((file) => String(file.fileName || file.name || "").trim().toLowerCase())
    .filter(Boolean);

  const expectedStates = expectedFiles.map((expectedName) => {
    const lowerExpected = expectedName.toLowerCase();
    const linked = linkedNames.some((name) => name === lowerExpected || name.endsWith(`/${lowerExpected}`));
    return { fileName: expectedName, linked };
  });

  const linkedCount = expectedStates.filter((entry) => entry.linked).length;
  return {
    expectedStates,
    linkedCount,
    allLinked: linkedCount === expectedFiles.length
  };
}

function getMissingExpectedFilesFromSources(sources, expectedFiles) {
  const selectedNames = (sources || [])
    .map((source) => String(source?.fileName || "").trim().toLowerCase())
    .filter(Boolean);
  const selectedSet = new Set(selectedNames);
  return expectedFiles.filter((expectedName) => !selectedSet.has(String(expectedName || "").toLowerCase()));
}

function getMissingExpectedFilesByAccountFromSources(sources, expectedFiles) {
  const byAccount = new Map();

  (sources || []).forEach((source) => {
    const accountLabel = String(source?.accountHintName || "").trim() || "(unlabeled account)";
    if (!byAccount.has(accountLabel)) {
      byAccount.set(accountLabel, new Set());
    }
    byAccount.get(accountLabel).add(String(source?.fileName || "").trim().toLowerCase());
  });

  return [...byAccount.entries()]
    .map(([accountLabel, selectedNames]) => ({
      accountLabel,
      missing: expectedFiles.filter((expectedName) => !selectedNames.has(String(expectedName || "").toLowerCase()))
    }))
    .filter((entry) => entry.missing.length)
    .sort((a, b) => a.accountLabel.localeCompare(b.accountLabel));
}

function formatInventoryDiagnostics(details) {
  const parts = [];

  if (details.stage) {
    parts.push(`stage=${details.stage}`);
  }

  if (typeof details.totalSources === "number") {
    parts.push(`sources=${details.totalSources}`);
  }

  if (details.sourceBreakdown) {
    const breakdown = Object.entries(details.sourceBreakdown)
      .map(([key, value]) => `${key}:${value}`)
      .join(",");
    parts.push(`parsed={${breakdown}}`);
  }

  if (typeof details.characterIndexMapSize === "number") {
    parts.push(`indexMap=${details.characterIndexMapSize}`);
  }

  if (typeof details.requiresCoreMap === "boolean") {
    parts.push(`requiresCoreMap=${details.requiresCoreMap}`);
  }

  if (typeof details.unresolvedProfiles === "number") {
    parts.push(`unresolvedProfiles=${details.unresolvedProfiles}`);
  }

  if (typeof details.unresolvedItems === "number") {
    parts.push(`unresolvedItems=${details.unresolvedItems}`);
  }

  if (details.unresolvedProfileSample) {
    parts.push(`unresolvedProfileSample=${details.unresolvedProfileSample}`);
  }

  if (details.unresolvedItemSample) {
    parts.push(`unresolvedItemSample=${details.unresolvedItemSample}`);
  }

  if (Array.isArray(details.files) && details.files.length) {
    const fileSummary = details.files
      .map((file) => `${file.fileName || "unknown"}:${file.sourceType || "unknown"}:${file.parsedCount || 0}`)
      .join("|");
    parts.push(`files=${fileSummary}`);
  }

  return parts.join(" ; ");
}

function downloadJsonFile(fileName, payload) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function readInventorySyncHistory() {
  try {
    const raw = localStorage.getItem(INVENTORY_SYNC_HISTORY_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveInventorySyncHistory(historyByAccount) {
  localStorage.setItem(INVENTORY_SYNC_HISTORY_KEY, JSON.stringify(historyByAccount || {}));
}

function SettingsPage() {
  const { user, hasFirebaseConfig, signInWithGoogle, signOutUser } = useAuth();
  const { data } = useUserCollections(user?.uid);
  const [nitPaths, setNitPaths] = useState([]);
  const [syncMessage, setSyncMessage] = useState("");
  const [bagnonSyncMessage, setBagnonSyncMessage] = useState("");
  const [bagnonIntegrityReport, setBagnonIntegrityReport] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isBagnonSyncing, setIsBagnonSyncing] = useState(false);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const [savingCharacterId, setSavingCharacterId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [classFilter, setClassFilter] = useState("all");
  const [realmFilter, setRealmFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [minLevelFilter, setMinLevelFilter] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState("all");
  const [activeRaidTagFilter, setActiveRaidTagFilter] = useState("all");
  const [connectedFiles, setConnectedFiles] = useState([]);
  const [pendingConnectHandles, setPendingConnectHandles] = useState([]);
  const [pendingAccountName, setPendingAccountName] = useState("");
  const [bagnonPaths, setBagnonPaths] = useState([]);
  const [bagnonConnectedFiles, setBagnonConnectedFiles] = useState([]);
  const [pendingBagnonConnectHandles, setPendingBagnonConnectHandles] = useState([]);
  const [pendingBagnonAccountName, setPendingBagnonAccountName] = useState("");
  const [bulkNovaAccountName, setBulkNovaAccountName] = useState("");
  const [bulkBagnonAccountName, setBulkBagnonAccountName] = useState("");
  const [selectedNovaSyncAccounts, setSelectedNovaSyncAccounts] = useState([]);
  const [selectedInventorySyncAccounts, setSelectedInventorySyncAccounts] = useState([]);
  const [inventorySyncHistoryByAccount, setInventorySyncHistoryByAccount] = useState({});
  const [isClearingInventory, setIsClearingInventory] = useState(false);
  const [requiredFilesCheckMessage, setRequiredFilesCheckMessage] = useState("");
  const [requiredFilesCheckRun, setRequiredFilesCheckRun] = useState(false);
  const accountNameById = useMemo(
    () => new Map(data.accounts.map((account) => [account.id, account.battleNetId])),
    [data.accounts]
  );
  const filterOptions = useMemo(
    () => getCharacterFilterOptions(data.characters, accountNameById),
    [data.characters, accountNameById]
  );
  const filteredCharacters = useMemo(
    () => data.characters.filter((character) => matchesCharacterFilters(character, {
      searchTerm,
      classFilter,
      factionFilter: "all",
      realmFilter,
      accountFilter,
      minLevelFilter,
      visibilityFilter,
      activeRaidTagFilter
    }, accountNameById)),
    [
      data.characters,
      searchTerm,
      classFilter,
      realmFilter,
      accountFilter,
      minLevelFilter,
      visibilityFilter,
      activeRaidTagFilter,
      accountNameById
    ]
  );

  const novaLinkedSummary = useMemo(
    () => summarizeLinkedFiles(connectedFiles, NOVA_EXPECTED_FILES),
    [connectedFiles]
  );

  const inventoryLinkedSummary = useMemo(
    () => summarizeLinkedFiles(bagnonConnectedFiles, INVENTORY_EXPECTED_FILES),
    [bagnonConnectedFiles]
  );

  const novaAccountOptions = useMemo(
    () => Array.from(
      new Set(
        connectedFiles
          .map((item) => String(item.accountName || "").trim() || "(unlabeled account)")
      )
    ).sort((a, b) => a.localeCompare(b)),
    [connectedFiles]
  );

  const inventoryAccountOptions = useMemo(
    () => Array.from(
      new Set(
        bagnonConnectedFiles
          .map((item) => String(item.accountName || "").trim() || "(unlabeled account)")
      )
    ).sort((a, b) => a.localeCompare(b)),
    [bagnonConnectedFiles]
  );

  const validateRequiredFiles = useCallback(() => {
    const missingNova = novaLinkedSummary.expectedStates
      .filter((entry) => !entry.linked)
      .map((entry) => entry.fileName);
    const missingInventory = inventoryLinkedSummary.expectedStates
      .filter((entry) => !entry.linked)
      .map((entry) => entry.fileName);
    const missing = [...missingNova, ...missingInventory];

    setRequiredFilesCheckRun(true);
    if (!missing.length) {
      setRequiredFilesCheckMessage("All required files are linked. Settings are ready to sync.");
      return;
    }

    setRequiredFilesCheckMessage(`Missing required files: ${missing.join(", ")}.`);
  }, [novaLinkedSummary, inventoryLinkedSummary]);

  const readSelectedFileIndexes = () => {
    try {
      const raw = localStorage.getItem(NIT_SELECTED_FILE_INDEXES_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value) => Number.isInteger(value) && value >= 0) : [];
    } catch {
      return [];
    }
  };

  const saveSelectedFileIndexes = (indexes) => {
    localStorage.setItem(NIT_SELECTED_FILE_INDEXES_KEY, JSON.stringify(indexes));
  };

  const readBagnonSelectedFileIndexes = () => {
    try {
      const raw = localStorage.getItem(BAGNON_SELECTED_FILE_INDEXES_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value) => Number.isInteger(value) && value >= 0) : [];
    } catch {
      return [];
    }
  };

  const saveBagnonSelectedFileIndexes = (indexes) => {
    localStorage.setItem(BAGNON_SELECTED_FILE_INDEXES_KEY, JSON.stringify(indexes));
  };

  useEffect(() => {
    const savedRaw = localStorage.getItem(NIT_PATHS_KEY);
    if (!savedRaw) {
      return;
    }

    try {
      const parsed = JSON.parse(savedRaw);
      if (Array.isArray(parsed)) {
        setNitPaths(parsed.filter(Boolean));
        return;
      }
    } catch {
      // Backward compatibility with old single-path storage.
    }

    if (savedRaw.trim()) {
      setNitPaths([savedRaw.trim()]);
    }
  }, []);

  useEffect(() => {
    const savedRaw = localStorage.getItem(BAGNON_PATHS_KEY);
    if (!savedRaw) {
      return;
    }

    try {
      const parsed = JSON.parse(savedRaw);
      if (Array.isArray(parsed)) {
        setBagnonPaths(parsed.filter(Boolean));
        return;
      }
    } catch {
      // Backward compatibility with old single-path storage.
    }

    if (savedRaw.trim()) {
      setBagnonPaths([savedRaw.trim()]);
    }
  }, []);

  useEffect(() => {
    try {
      const rawNovaFilters = localStorage.getItem(NOVA_SYNC_ACCOUNT_FILTERS_KEY);
      if (rawNovaFilters) {
        const parsedNovaFilters = JSON.parse(rawNovaFilters);
        if (Array.isArray(parsedNovaFilters)) {
          setSelectedNovaSyncAccounts(parsedNovaFilters.filter((entry) => String(entry || "").trim()));
        }
      }
    } catch {
      // Ignore invalid stored sync account filter format.
    }

    try {
      const rawInventoryFilters = localStorage.getItem(INVENTORY_SYNC_ACCOUNT_FILTERS_KEY);
      if (rawInventoryFilters) {
        const parsedInventoryFilters = JSON.parse(rawInventoryFilters);
        if (Array.isArray(parsedInventoryFilters)) {
          setSelectedInventorySyncAccounts(parsedInventoryFilters.filter((entry) => String(entry || "").trim()));
        }
      }
    } catch {
      // Ignore invalid stored sync account filter format.
    }

    setInventorySyncHistoryByAccount(readInventorySyncHistory());
  }, []);

  const hydrateConnectedFiles = useCallback(() => {
    if (!window.indexedDB) {
      return;
    }

    loadConnectedHandles()
      .then((handles) => {
        const selectedIndexes = readSelectedFileIndexes();
        const meta = readConnectedFileMeta();
        setConnectedFiles(buildConnectedFileEntries(handles, meta, selectedIndexes));
      })
      .catch(() => {
        setConnectedFiles([]);
      });
  }, []);

  useEffect(() => {
    hydrateConnectedFiles();
  }, [hydrateConnectedFiles]);

  const hydrateBagnonConnectedFiles = useCallback(() => {
    if (!window.indexedDB) {
      return;
    }

    loadBagnonConnectedHandles()
      .then((handles) => {
        const selectedIndexes = readBagnonSelectedFileIndexes();
        const meta = readBagnonConnectedFileMeta();
        setBagnonConnectedFiles(buildBagnonConnectedFileEntries(handles, meta, selectedIndexes));
      })
      .catch(() => {
        setBagnonConnectedFiles([]);
      });
  }, []);

  useEffect(() => {
    hydrateBagnonConnectedFiles();
  }, [hydrateBagnonConnectedFiles]);

  useEffect(() => {
    setSelectedNovaSyncAccounts((prev) => {
      const available = new Set(novaAccountOptions.map((label) => normalize(label)));
      return prev.filter((label) => available.has(normalize(label)));
    });
  }, [novaAccountOptions]);

  useEffect(() => {
    setSelectedInventorySyncAccounts((prev) => {
      const available = new Set(inventoryAccountOptions.map((label) => normalize(label)));
      return prev.filter((label) => available.has(normalize(label)));
    });
  }, [inventoryAccountOptions]);

  useEffect(() => {
    localStorage.setItem(NOVA_SYNC_ACCOUNT_FILTERS_KEY, JSON.stringify(selectedNovaSyncAccounts));
  }, [selectedNovaSyncAccounts]);

  useEffect(() => {
    localStorage.setItem(INVENTORY_SYNC_ACCOUNT_FILTERS_KEY, JSON.stringify(selectedInventorySyncAccounts));
  }, [selectedInventorySyncAccounts]);

  const savePaths = (paths) => {
    setNitPaths(paths);
    localStorage.setItem(NIT_PATHS_KEY, JSON.stringify(paths));
  };

  const saveBagnonPaths = (paths) => {
    setBagnonPaths(paths);
    localStorage.setItem(BAGNON_PATHS_KEY, JSON.stringify(paths));
  };

  const syncFromLuaTexts = async (sources) => {
    if (!user) {
      return;
    }

    setIsSyncing(true);
    setSyncMessage("Sync in progress...");

    try {
      const accountMap = new Map(data.accounts.map((account) => [normalize(account.battleNetId), account.id]));
      const parsedCharacters = [];
      const parsed = [];
      const activeRaids = [];
      const parsedWorldBuffStates = [];
      const sourceWarnings = [];

      for (const source of sources) {
        const sourceAccount = (source.accountHintName || "").trim();
        let sourceAccountId = "";
        if (sourceAccount) {
          const normalized = normalize(sourceAccount);
          sourceAccountId = accountMap.get(normalized) || "";
          if (!sourceAccountId) {
            const created = await addAccount(user.uid, sourceAccount);
            sourceAccountId = created.id;
            accountMap.set(normalized, sourceAccountId);
          }
        }

        const parsedFromSource = parseNovaCharacters(source.text).map((entry) => ({
          ...entry,
          accountId: sourceAccountId
        }));
        parsedCharacters.push(...parsedFromSource);
        const worldBuffStates = parseNovaWorldBuffs(source.text).map((entry) => ({
          ...entry,
          accountId: sourceAccountId
        }));
        parsedWorldBuffStates.push(...worldBuffStates);
        parsedCharacters.push(...worldBuffStates.map((entry) => ({
          name: entry.name,
          realm: entry.realm,
          className: entry.className || "Unknown",
          faction: entry.faction || "Unknown",
          level: typeof entry.level === "number" ? entry.level : null,
          restedXp: null,
          accountId: sourceAccountId
        })));
        const savedEntries = parseNovaSavedInstances(source.text);
        const activeEntries = parseNovaActiveInstances(source.text);
        parsed.push(...savedEntries);
        activeRaids.push(...activeEntries);

        sourceWarnings.push(
          ...validateNovaSourceHealth({
            fileName: source.fileName || "",
            text: source.text,
            parsedCharactersCount: parsedFromSource.length,
            parsedSavedCount: savedEntries.length,
            parsedWorldBuffCount: worldBuffStates.length
          })
        );
      }

      const dedupedParsedCharacters = new Map();
      parsedCharacters.forEach((entry) => {
        const key = characterKey(entry.name, entry.realm);
        if (!dedupedParsedCharacters.has(key)) {
          dedupedParsedCharacters.set(key, entry);
        }
      });

      const charactersByKey = new Map(
        data.characters.map((character) => [characterKey(character.name, character.realm), character])
      );
      const createdCharacters = [];
      const defaultAccountId = data.accounts.length === 1 ? data.accounts[0].id : "";

      for (const parsedCharacter of dedupedParsedCharacters.values()) {
        const key = characterKey(parsedCharacter.name, parsedCharacter.realm);
        if (!charactersByKey.has(key)) {
          const payload = {
            name: parsedCharacter.name,
            class: parsedCharacter.className || "Unknown",
            faction: parsedCharacter.faction || "Unknown",
            realm: parsedCharacter.realm,
            accountId: parsedCharacter.accountId || defaultAccountId,
            level: typeof parsedCharacter.level === "number" ? parsedCharacter.level : null,
            restedXp: typeof parsedCharacter.restedXp === "number" ? parsedCharacter.restedXp : 0,
            avatarUrl: "",
            showOnDashboard: true,
            activeRaidTag: "",
            importedFromNova: true
          };
          const created = await addCharacter(user.uid, payload);
          const createdCharacter = { id: created.id, ...payload };
          charactersByKey.set(key, createdCharacter);
          createdCharacters.push(createdCharacter);
        } else if (defaultAccountId) {
          const existing = charactersByKey.get(key);
          if (existing) {
            const updates = {};
            if (!existing.accountId) {
              updates.accountId = defaultAccountId;
              existing.accountId = defaultAccountId;
            }
            if (
              typeof parsedCharacter.level === "number"
              && existing.level !== parsedCharacter.level
            ) {
              updates.level = parsedCharacter.level;
              existing.level = parsedCharacter.level;
            }
            if (
              typeof parsedCharacter.restedXp === "number"
              && existing.restedXp !== parsedCharacter.restedXp
            ) {
              updates.restedXp = parsedCharacter.restedXp;
              existing.restedXp = parsedCharacter.restedXp;
            }

            if (Object.keys(updates).length) {
              await updateCharacter(existing.id, updates);
            }
          }
        } else {
          const existing = charactersByKey.get(key);
          if (
            existing
            && typeof parsedCharacter.level === "number"
            && existing.level !== parsedCharacter.level
          ) {
            const updates = { level: parsedCharacter.level };
            if (typeof parsedCharacter.restedXp === "number") {
              updates.restedXp = parsedCharacter.restedXp;
              existing.restedXp = parsedCharacter.restedXp;
            }
            await updateCharacter(existing.id, updates);
            existing.level = parsedCharacter.level;
          } else if (
            existing
            && typeof parsedCharacter.restedXp === "number"
            && existing.restedXp !== parsedCharacter.restedXp
          ) {
            await updateCharacter(existing.id, { restedXp: parsedCharacter.restedXp });
            existing.restedXp = parsedCharacter.restedXp;
          }
        }
      }

      const allCharacters = [...data.characters, ...createdCharacters];
      const parsedByCharacter = new Map();

      parsed.forEach((entry) => {
        const key = `${normalize(entry.characterName)}|${normalize(entry.realm)}`;
        if (!parsedByCharacter.has(key)) {
          parsedByCharacter.set(key, []);
        }
        parsedByCharacter.get(key).push(entry);
      });

      const updates = [];

      allCharacters.forEach((character) => {
        const key = `${normalize(character.name)}|${normalize(character.realm)}`;
        if (!parsedByCharacter.has(key)) {
          return;
        }

        const entries = parsedByCharacter.get(key) || [];
        const lockedRaids = new Map(entries.map((item) => [item.raidName, item]));

        RAIDS.forEach((raid) => {
          const locked = lockedRaids.get(raid.name);
          updates.push(
            upsertRaidStatus(user.uid, {
              characterId: character.id,
              raidName: raid.name,
              completed: Boolean(locked),
              lastRunDate: null,
              resetDate: locked ? locked.resetDate : null
            })
          );
        });
      });

      await Promise.all(updates);

      const worldBuffStateByCharacter = new Map();
      parsedWorldBuffStates.forEach((entry) => {
        const key = characterKey(entry.name, entry.realm);
        const existing = worldBuffStateByCharacter.get(key);

        if (!existing) {
          worldBuffStateByCharacter.set(key, {
            buffs: new Set(entry.buffs || []),
            storedBuffs: new Set(entry.storedBuffs || []),
            chronoCount: entry.chronoCount || 0,
            onyCount: entry.onyCount || 0,
            nefCount: entry.nefCount || 0,
            rendCount: entry.rendCount || 0,
            zanCount: entry.zanCount || 0,
            dmfCount: entry.dmfCount || 0
          });
          return;
        }

        (entry.buffs || []).forEach((buff) => existing.buffs.add(buff));
        (entry.storedBuffs || []).forEach((buff) => existing.storedBuffs.add(buff));
        existing.chronoCount = Math.max(existing.chronoCount || 0, entry.chronoCount || 0);
        existing.onyCount = Math.max(existing.onyCount || 0, entry.onyCount || 0);
        existing.nefCount = Math.max(existing.nefCount || 0, entry.nefCount || 0);
        existing.rendCount = Math.max(existing.rendCount || 0, entry.rendCount || 0);
        existing.zanCount = Math.max(existing.zanCount || 0, entry.zanCount || 0);
        existing.dmfCount = Math.max(existing.dmfCount || 0, entry.dmfCount || 0);
      });

      const buffUpdateOps = [];
      allCharacters.forEach((character) => {
        const key = characterKey(character.name, character.realm);
        const buffState = worldBuffStateByCharacter.get(key);
        if (!buffState) {
          return;
        }

        buffUpdateOps.push(
          updateCharacter(character.id, {
            buffs: [...buffState.buffs].sort((a, b) => a.localeCompare(b)),
            storedBuffs: [...buffState.storedBuffs].sort((a, b) => a.localeCompare(b)),
            chronoCount: buffState.chronoCount || 0,
            buffCounts: {
              ony: buffState.onyCount || 0,
              nef: buffState.nefCount || 0,
              rend: buffState.rendCount || 0,
              zan: buffState.zanCount || 0,
              dmf: buffState.dmfCount || 0
            },
            lastBuffSyncAt: new Date().toISOString()
          })
        );
      });

      if (buffUpdateOps.length) {
        await Promise.all(buffUpdateOps);
      }

      const totalMatches = parsed.length;
      const currentRaidNames = Array.from(new Set(activeRaids.map((entry) => entry.raidName)));
      const warningSummary = formatImportWarnings(sourceWarnings);
      setSyncMessage(
        `Sync complete. Imported ${totalMatches} saved raid entries, ${parsedWorldBuffStates.length} buff snapshots, and added ${createdCharacters.length} new characters.${currentRaidNames.length ? ` Current raid activity: ${currentRaidNames.join(", ")}.` : ""}${warningSummary ? ` Validation warnings: ${warningSummary}.` : ""}`
      );
    } catch (error) {
      setSyncMessage("Sync failed. Ensure you selected a valid NovaInstanceTracker.lua file.");
    } finally {
      setIsSyncing(false);
    }
  };

  const onConnectFiles = async () => {
    if (!window.showOpenFilePicker) {
      setSyncMessage("Your browser does not support direct file connections. Use Update and pick files.");
      return;
    }

    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: "Lua files",
            accept: {
              "text/plain": [".lua"]
            }
          }
        ]
      });

      if (!handles.length) {
        return;
      }

      const defaultAccountLabel = getDefaultAccountLabel(data.accounts, user?.email);
      setPendingConnectHandles(handles);
      setPendingAccountName(
        getUniqueAccountHint(nitPaths)
        || getUniqueAccountHint(connectedFiles.map((item) => item.accountName))
        || defaultAccountLabel
      );
      setSyncMessage("Select or type an account name for selected files, then confirm.");
    } catch {
      // User cancelled picker.
    }
  };

  const onCancelPendingConnect = () => {
    setPendingConnectHandles([]);
    setPendingAccountName("");
  };

  const onConfirmPendingConnect = async () => {
    if (!pendingConnectHandles.length) {
      return;
    }

    try {
      const defaultAccountLabel = getDefaultAccountLabel(data.accounts, user?.email);
      const accountHintName = pendingAccountName.trim() || defaultAccountLabel;
      const existingHandles = await loadConnectedHandles();
      const existingMeta = readConnectedFileMeta();

      const merged = await mergeConnectedHandles(existingHandles, pendingConnectHandles);
      const addedCount = merged.length - existingHandles.length;
      const nextMeta = [...existingMeta];
      for (let index = 0; index < addedCount; index += 1) {
        nextMeta.push({ accountName: accountHintName, fileName: pendingConnectHandles[index]?.name || "" });
      }

      await saveConnectedHandles(merged);
      saveConnectedFileMeta(nextMeta);
      setConnectedFiles(buildConnectedFileEntries(merged, nextMeta));
      saveSelectedFileIndexes(merged.map((_, index) => index));
      if (accountHintName) {
        savePaths([accountHintName]);
      }
      setSyncMessage(
        `Added ${pendingConnectHandles.length} file selection(s). ${merged.length} Nova file(s) now connected.`
      );
      setPendingConnectHandles([]);
      setPendingAccountName("");
    } catch {
      setSyncMessage("Could not connect selected files. Try again.");
    }
  };

  const syncBagnonFromLuaTexts = async (sources) => {
    if (!user) {
      return;
    }

    setIsBagnonSyncing(true);
    setBagnonSyncMessage("Sync in progress...");
    setBagnonIntegrityReport(null);

    let syncStage = "initializing";
    const syncDiagnostics = {
      totalSources: Array.isArray(sources) ? sources.length : 0,
      sourceBreakdown: {
        containers: 0,
        inventory: 0,
        characters: 0,
        core: 0,
        unknown: 0
      },
      files: [],
      characterIndexMapSize: 0,
      requiresCoreMap: false,
      unresolvedProfiles: 0,
      unresolvedItems: 0,
      unresolvedProfileSample: "",
      unresolvedItemSample: ""
    };
    const integrityReport = {
      status: "in-progress",
      stage: syncStage,
      reason: "",
      totals: {
        itemStacks: 0,
        totalItemQuantity: 0,
        uniqueItems: 0,
        ownersWithItems: 0,
        snapshotCharacters: 0,
        equipmentProfiles: 0,
        characterProfiles: 0
      },
      sourceBreakdown: syncDiagnostics.sourceBreakdown,
      files: syncDiagnostics.files,
      unresolvedProfiles: 0,
      unresolvedItems: 0,
      indexedAccountLabels: [],
      accountBreakdown: [],
      warnings: []
    };

    const updateInventorySyncHistory = ({
      accountLabels = [],
      status,
      stage,
      reason,
      unresolvedProfiles = 0,
      unresolvedItems = 0,
      totals,
      warnings = []
    }) => {
      const next = {
        ...inventorySyncHistoryByAccount
      };
      const labels = Array.isArray(accountLabels) && accountLabels.length
        ? accountLabels
        : ["(unlabeled account)"];

      labels.forEach((label) => {
        const key = String(label || "").trim() || "(unlabeled account)";
        next[key] = {
          accountLabel: key,
          lastRunAt: new Date().toISOString(),
          status: status || "failed",
          stage: stage || "unknown",
          reason: reason || "",
          unresolvedProfiles,
          unresolvedItems,
          totals: {
            itemStacks: totals?.itemStacks || 0,
            totalItemQuantity: totals?.totalItemQuantity || 0,
            uniqueItems: totals?.uniqueItems || 0,
            ownersWithItems: totals?.ownersWithItems || 0,
            snapshotCharacters: totals?.snapshotCharacters || 0
          },
          warningsCount: Array.isArray(warnings) ? warnings.length : 0
        };
      });

      setInventorySyncHistoryByAccount(next);
      saveInventorySyncHistory(next);
    };

    try {
      syncStage = "parsing-sources";
      const parsedItems = [];
      const parsedInventoryProfiles = [];
      const parsedCharacterProfiles = [];
      const characterIndexMapByAccount = new Map();
      const sourceWarnings = [];

      const getAccountKey = (value) => normalize(value) || "__default__";
      const getEntryAccountKey = (entry) => getAccountKey(entry?.accountHintName);
      const getCharacterMapForEntry = (entry) => characterIndexMapByAccount.get(getEntryAccountKey(entry)) || null;
      const indexKey = (entry) => {
        if (!Number.isInteger(entry?.characterIndex)) {
          return "";
        }
        return `${getEntryAccountKey(entry)}|${entry.characterIndex}`;
      };

      for (const source of sources) {
        const sourceType = detectDataStoreSourceType(source.fileName, source.text);
        let parsedFromSourceCount = 0;

        if (syncDiagnostics.sourceBreakdown[sourceType] === undefined) {
          syncDiagnostics.sourceBreakdown.unknown += 1;
        } else {
          syncDiagnostics.sourceBreakdown[sourceType] += 1;
        }

        if (sourceType === "containers") {
          const items = parseDataStoreContainers(source.text, source.fileName || "", source.accountHintName || "");
          parsedItems.push(...items);
          parsedFromSourceCount = items.length;
        }
        if (sourceType === "inventory") {
          const profiles = parseDataStoreInventory(source.text, source.fileName || "", source.accountHintName || "");
          parsedInventoryProfiles.push(...profiles);
          parsedFromSourceCount = profiles.length;
        }
        if (sourceType === "characters") {
          const profiles = parseDataStoreCharacters(source.text, source.fileName || "", source.accountHintName || "");
          parsedCharacterProfiles.push(...profiles);
          parsedFromSourceCount = profiles.length;
        }
        if (sourceType === "core") {
          const accountKey = getAccountKey(source.accountHintName);
          if (!characterIndexMapByAccount.has(accountKey)) {
            characterIndexMapByAccount.set(accountKey, new Map());
          }
          const accountIndexMap = characterIndexMapByAccount.get(accountKey);
          const map = parseDataStoreCharacterIndexMap(source.text);
          map.forEach((value, index) => {
            if (!accountIndexMap.has(index)) {
              accountIndexMap.set(index, value);
            }
          });
          parsedFromSourceCount = map.size;
        }

        syncDiagnostics.files.push({
          fileName: source.fileName || "",
          sourceType,
          parsedCount: parsedFromSourceCount
        });

        sourceWarnings.push(
          ...validateDataStoreSourceHealth({
            fileName: source.fileName || "",
            text: source.text,
            sourceType,
            parsedCount: parsedFromSourceCount
          })
        );
      }

      syncDiagnostics.characterIndexMapSize = [...characterIndexMapByAccount.values()]
        .reduce((sum, map) => sum + map.size, 0);

      const characterByIndex = new Map();
      syncStage = "resolving-identities";
      const resolvedCharacterProfilesRaw = parsedCharacterProfiles.map((profile) => {
        const sourceCharacterMap = getCharacterMapForEntry(profile);
        const key = indexKey(profile);
        const mapped = Number.isInteger(profile.characterIndex)
          ? sourceCharacterMap?.get(profile.characterIndex) || null
          : null;
        const fallback = Number.isInteger(profile.characterIndex)
          ? characterByIndex.get(key)
          : null;
        const characterName = profile.characterName || mapped?.name || fallback?.characterName || "";
        const realm = profile.realm || mapped?.realm || fallback?.realm || "";
        const resolved = {
          ...profile,
          characterName,
          realm
        };

        if (key && characterName) {
          characterByIndex.set(key, {
            characterName,
            realm
          });
        }

        return resolved;
      });

      const resolvedInventoryProfilesRaw = parsedInventoryProfiles.map((profile) => {
        const sourceCharacterMap = getCharacterMapForEntry(profile);
        const key = indexKey(profile);
        const mapped = Number.isInteger(profile.characterIndex)
          ? sourceCharacterMap?.get(profile.characterIndex) || null
          : null;
        const fallback = Number.isInteger(profile.characterIndex)
          ? characterByIndex.get(key)
          : null;
        const characterName = profile.characterName || mapped?.name || fallback?.characterName || "";
        const realm = profile.realm || mapped?.realm || fallback?.realm || "";
        return {
          ...profile,
          characterName,
          realm
        };
      });

      const resolvedItemsRaw = parsedItems
        .map((item) => {
          const sourceCharacterMap = getCharacterMapForEntry(item);
          const key = indexKey(item);
          const mapped = Number.isInteger(item.characterIndex)
            ? sourceCharacterMap?.get(item.characterIndex) || null
            : null;
          const fallback = Number.isInteger(item.characterIndex)
            ? characterByIndex.get(key)
            : null;
          const characterName = item.characterName || mapped?.name || fallback?.characterName || "";
          const realm = item.realm || mapped?.realm || fallback?.realm || "";
          return {
            ...item,
            characterName,
            realm
          };
        });

      const resolvedCharacterProfiles = resolvedCharacterProfilesRaw;
      const resolvedInventoryProfiles = resolvedInventoryProfilesRaw;
      const resolvedItems = resolvedItemsRaw
        .filter((item) => item.characterName && item.realm);

      const requiresCoreMap = parsedItems.concat(parsedInventoryProfiles, parsedCharacterProfiles).some(
        (entry) => Number.isInteger(entry.characterIndex)
      );
      syncDiagnostics.requiresCoreMap = requiresCoreMap;

      const indexedAccounts = new Set(
        parsedItems
          .concat(parsedInventoryProfiles, parsedCharacterProfiles)
          .filter((entry) => Number.isInteger(entry.characterIndex))
          .map((entry) => getEntryAccountKey(entry))
      );
      const missingCoreAccounts = [...indexedAccounts].filter(
        (accountKey) => !(characterIndexMapByAccount.get(accountKey)?.size)
      );
      integrityReport.indexedAccountLabels = Array.from(
        new Set(
          parsedItems
            .concat(parsedInventoryProfiles, parsedCharacterProfiles)
            .filter((entry) => Number.isInteger(entry.characterIndex))
            .map((entry) => String(entry.accountHintName || "").trim() || "(unlabeled account)")
        )
      ).sort((a, b) => a.localeCompare(b));

      const unresolvedProfileRecords = [...resolvedInventoryProfiles, ...resolvedCharacterProfiles]
        .filter((profile) => !profile.characterName || !profile.realm);
      const unresolvedItemRecords = resolvedItemsRaw.filter((item) => !item.characterName || !item.realm);
      syncDiagnostics.unresolvedProfiles = unresolvedProfileRecords.length;
      syncDiagnostics.unresolvedItems = unresolvedItemRecords.length;
      integrityReport.unresolvedProfiles = unresolvedProfileRecords.length;
      integrityReport.unresolvedItems = unresolvedItemRecords.length;
      syncDiagnostics.unresolvedProfileSample = unresolvedProfileRecords[0]
        ? JSON.stringify({
          sourceType: unresolvedProfileRecords[0].sourceType || "unknown",
          characterIndex: unresolvedProfileRecords[0].characterIndex,
          characterName: unresolvedProfileRecords[0].characterName || "",
          realm: unresolvedProfileRecords[0].realm || ""
        })
        : "";
      syncDiagnostics.unresolvedItemSample = unresolvedItemRecords[0]
        ? JSON.stringify({
          sourceType: unresolvedItemRecords[0].sourceType || "unknown",
          characterIndex: unresolvedItemRecords[0].characterIndex,
          itemId: unresolvedItemRecords[0].itemId || "",
          characterName: unresolvedItemRecords[0].characterName || "",
          realm: unresolvedItemRecords[0].realm || ""
        })
        : "";

      if (requiresCoreMap && missingCoreAccounts.length) {
        const missingAccountLabels = Array.from(
          new Set(
            parsedItems
              .concat(parsedInventoryProfiles, parsedCharacterProfiles)
              .filter((entry) => Number.isInteger(entry.characterIndex) && missingCoreAccounts.includes(getEntryAccountKey(entry)))
              .map((entry) => String(entry.accountHintName || "").trim() || "(unlabeled account)")
          )
        );
        integrityReport.status = "failed";
        integrityReport.stage = syncStage;
        integrityReport.reason = `Missing DataStore.lua for account(s): ${missingAccountLabels.join(", ")}`;
        integrityReport.warnings = [...sourceWarnings];
        setBagnonIntegrityReport(integrityReport);
        updateInventorySyncHistory({
          accountLabels: missingAccountLabels,
          status: integrityReport.status,
          stage: integrityReport.stage,
          reason: integrityReport.reason,
          unresolvedProfiles: integrityReport.unresolvedProfiles,
          unresolvedItems: integrityReport.unresolvedItems,
          totals: integrityReport.totals,
          warnings: integrityReport.warnings
        });
        throw new Error(
          `Sync blocked: DataStore.lua is required for deterministic character mapping for account(s): ${missingAccountLabels.join(", ")}. Connect DataStore.lua from the same SavedVariables folder for each listed account and sync again.`
        );
      }

      const unresolvedProfilesCount = resolvedInventoryProfiles.filter(
        (profile) => !profile.characterName || !profile.realm
      ).length + resolvedCharacterProfiles.filter(
        (profile) => !profile.characterName || !profile.realm
      ).length;
      if (unresolvedProfilesCount > 0) {
        integrityReport.status = "failed";
        integrityReport.stage = syncStage;
        integrityReport.reason = `${unresolvedProfilesCount} profile record(s) could not be mapped to character+realm.`;
        integrityReport.warnings = [...sourceWarnings];
        setBagnonIntegrityReport(integrityReport);
        updateInventorySyncHistory({
          accountLabels: integrityReport.indexedAccountLabels,
          status: integrityReport.status,
          stage: integrityReport.stage,
          reason: integrityReport.reason,
          unresolvedProfiles: integrityReport.unresolvedProfiles,
          unresolvedItems: integrityReport.unresolvedItems,
          totals: integrityReport.totals,
          warnings: integrityReport.warnings
        });
        throw new Error(
          `Sync blocked: ${unresolvedProfilesCount} profile record(s) could not be mapped to character+realm. Ensure DataStore.lua, DataStore_Characters.lua, and DataStore_Inventory.lua come from the same account snapshot.`
        );
      }

      syncStage = "merging-profiles";
      const mergedInventoryProfiles = mergeInventoryProfiles(
        resolvedInventoryProfiles.filter((profile) => profile.characterName && profile.realm)
      );
      const mergedCharacterProfiles = mergeCharacterProfiles(
        resolvedCharacterProfiles.filter((profile) => profile.characterName && profile.realm)
      );

      const accountByNormalizedName = new Map(
        data.accounts.map((account) => [normalize(account.battleNetId), account])
      );
      const resolveAccountId = async (accountHintName) => {
        const normalized = normalize(accountHintName);
        if (!normalized) {
          return "";
        }

        const existing = accountByNormalizedName.get(normalized);
        if (existing?.id) {
          return existing.id;
        }

        const created = await addAccount(user.uid, accountHintName.trim());
        const createdAccount = { id: created.id, battleNetId: accountHintName.trim() };
        accountByNormalizedName.set(normalized, createdAccount);
        return created.id;
      };

      syncStage = "resolving-accounts";
      for (const profile of mergedCharacterProfiles) {
        if (!profile.accountId && profile.accountHintName) {
          profile.accountId = await resolveAccountId(profile.accountHintName);
        }
      }
      for (const profile of mergedInventoryProfiles) {
        if (!profile.accountId && profile.accountHintName) {
          profile.accountId = await resolveAccountId(profile.accountHintName);
        }
      }

      const charactersByKey = new Map(
        data.characters.map((character) => [characterProfileKey(character.name, character.realm), character])
      );
      const createOrGetCharacter = async (profile) => {
        const key = characterProfileKey(profile.characterName, profile.realm);
        const existing = charactersByKey.get(key);
        if (existing) {
          return existing;
        }

        const payload = {
          name: profile.characterName,
          class: profile.className || "Unknown",
          faction: profile.faction || "Unknown",
          realm: profile.realm,
          accountId: profile.accountId || "",
          level: typeof profile.level === "number" ? profile.level : null,
          restedXp: typeof profile.restXp === "number" ? profile.restXp : 0,
          avatarUrl: "",
          showOnDashboard: true,
          activeRaidTag: "",
          importedFromDataStore: true
        };

        const created = await addCharacter(user.uid, payload);
        const createdCharacter = { id: created.id, ...payload };
        charactersByKey.set(key, createdCharacter);
        return createdCharacter;
      };

      syncStage = "ensuring-characters";
      for (const profile of mergedCharacterProfiles) {
        await createOrGetCharacter(profile);
      }
      for (const profile of mergedInventoryProfiles) {
        await createOrGetCharacter(profile);
      }

      const profileOps = [];

      mergedInventoryProfiles.forEach((profile) => {
        const character = charactersByKey.get(characterProfileKey(profile.characterName, profile.realm));
        if (!character) {
          return;
        }

        profileOps.push(
          updateCharacter(character.id, {
            averageItemLevel: typeof profile.averageItemLevel === "number" ? profile.averageItemLevel : null,
            overallItemLevel: typeof profile.overallItemLevel === "number" ? profile.overallItemLevel : null,
            equippedItems: Array.isArray(profile.equippedItems) ? profile.equippedItems : [],
            lastInventoryUpdate: profile.lastInventoryUpdate || null,
            lastInventorySyncAt: new Date().toISOString()
          })
        );
      });

      mergedCharacterProfiles.forEach((profile) => {
        const character = charactersByKey.get(characterProfileKey(profile.characterName, profile.realm));
        if (!character) {
          return;
        }

        const updates = {
          zone: profile.zone || "",
          subZone: profile.subZone || "",
          bindLocation: profile.bindLocation || "",
          guildName: profile.guildName || "",
          guildRankName: profile.guildRankName || "",
          guildRankIndex: typeof profile.guildRankIndex === "number" ? profile.guildRankIndex : null,
          money: typeof profile.money === "number" ? profile.money : null,
          isResting: typeof profile.isResting === "boolean" ? profile.isResting : null,
          played: typeof profile.played === "number" ? profile.played : null,
          playedThisLevel: typeof profile.playedThisLevel === "number" ? profile.playedThisLevel : null,
          xp: typeof profile.xp === "number" ? profile.xp : null,
          xpMax: typeof profile.xpMax === "number" ? profile.xpMax : null,
          restXp: typeof profile.restXp === "number" ? profile.restXp : null,
          lastCharacterUpdate: profile.lastCharacterUpdate || null,
          lastLogoutTimestamp: profile.lastLogoutTimestamp || null,
          lastCharacterSyncAt: new Date().toISOString()
        };

        profileOps.push(updateCharacter(character.id, updates));
      });

      if (profileOps.length) {
        syncStage = "writing-profiles";
        await Promise.all(profileOps);
      }

      syncStage = "finalizing";
      const uniqueItems = new Set(resolvedItems.map((item) => `${item.itemId || ""}|${normalize(item.itemName)}`));
      const totalItemQuantity = resolvedItems.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
      const ownersWithItems = new Set(
        resolvedItems.map((item) => `${normalize(item.characterName)}|${normalize(item.realm)}`)
      ).size;
      const importedCharacterMap = new Map();
      resolvedItems.forEach((item) => {
        if (!item.characterName || !item.realm) {
          return;
        }
        const key = characterLooseKey(item.characterName, item.realm);
        if (!importedCharacterMap.has(key)) {
          importedCharacterMap.set(key, `${item.characterName} (${item.realm})`);
        }
      });
      mergedCharacterProfiles.forEach((profile) => {
        if (!profile.characterName || !profile.realm) {
          return;
        }
        const key = characterLooseKey(profile.characterName, profile.realm);
        if (!importedCharacterMap.has(key)) {
          importedCharacterMap.set(key, `${profile.characterName} (${profile.realm})`);
        }
      });

      const importedCharacterLabels = [...importedCharacterMap.values()].sort((a, b) => a.localeCompare(b));
      const snapshotCharacterCount = importedCharacterLabels.length;
      const missingKnownCharacters = data.characters
        .filter((character) => !importedCharacterMap.has(characterLooseKey(character.name, character.realm)))
        .map((character) => `${character.name} (${character.realm})`)
        .sort((a, b) => a.localeCompare(b));
      const importedPreview = importedCharacterLabels.slice(0, 12).join(", ");
      const missingPreview = missingKnownCharacters.slice(0, 12).join(", ");

      const accountBreakdownMap = new Map();
      const ensureAccountStats = (accountLabel) => {
        if (!accountBreakdownMap.has(accountLabel)) {
          accountBreakdownMap.set(accountLabel, {
            owners: new Set(),
            snapshotCharacters: new Set()
          });
        }
        return accountBreakdownMap.get(accountLabel);
      };
      const resolveAccountLabel = (value) => String(value || "").trim() || "(unlabeled account)";

      resolvedItems.forEach((item) => {
        const accountLabel = resolveAccountLabel(item.accountHintName);
        const stats = ensureAccountStats(accountLabel);
        stats.owners.add(characterLooseKey(item.characterName, item.realm));
        stats.snapshotCharacters.add(characterLooseKey(item.characterName, item.realm));
      });

      mergedCharacterProfiles.forEach((profile) => {
        const accountLabel = resolveAccountLabel(profile.accountHintName);
        const stats = ensureAccountStats(accountLabel);
        stats.snapshotCharacters.add(characterLooseKey(profile.characterName, profile.realm));
      });

      const accountBreakdown = [...accountBreakdownMap.entries()]
        .map(([accountName, stats]) => ({
          accountName,
          ownersWithItems: stats.owners.size,
          snapshotCharacters: stats.snapshotCharacters.size
        }))
        .sort((a, b) => a.accountName.localeCompare(b.accountName));
      const accountBreakdownText = accountBreakdown
        .map((entry) => `${entry.accountName}: ${entry.ownersWithItems} owners / ${entry.snapshotCharacters} snapshot`)
        .join(" | ");

      syncStage = "writing-inventory-items";
      await replaceInventoryItems(user.uid, resolvedItems, {
        ownersWithItems,
        snapshotCharacterCount,
        equipmentProfileCount: mergedInventoryProfiles.length,
        characterProfileCount: mergedCharacterProfiles.length,
        uniqueItemCount: uniqueItems.size,
        totalItemQuantity,
        accountBreakdown
      });

      integrityReport.status = "passed";
      integrityReport.stage = syncStage;
      integrityReport.reason = "All deterministic mapping checks passed.";
      integrityReport.totals = {
        itemStacks: resolvedItems.length,
        totalItemQuantity,
        uniqueItems: uniqueItems.size,
        ownersWithItems,
        snapshotCharacters: snapshotCharacterCount,
        equipmentProfiles: mergedInventoryProfiles.length,
        characterProfiles: mergedCharacterProfiles.length
      };
      integrityReport.accountBreakdown = accountBreakdown;
      integrityReport.warnings = [...sourceWarnings];
      setBagnonIntegrityReport(integrityReport);
      updateInventorySyncHistory({
        accountLabels: accountBreakdown.map((entry) => entry.accountName),
        status: integrityReport.status,
        stage: integrityReport.stage,
        reason: integrityReport.reason,
        unresolvedProfiles: integrityReport.unresolvedProfiles,
        unresolvedItems: integrityReport.unresolvedItems,
        totals: integrityReport.totals,
        warnings: integrityReport.warnings
      });

      const warningSummary = formatImportWarnings(sourceWarnings);
      setBagnonSyncMessage(
        `Sync complete. Imported ${resolvedItems.length} item stacks (${totalItemQuantity} total item count) across ${uniqueItems.size} unique item(s). Owners with items: ${ownersWithItems}. Snapshot characters: ${snapshotCharacterCount}. Equipment profile(s): ${mergedInventoryProfiles.length}. Character profile snapshot(s): ${mergedCharacterProfiles.length}.${accountBreakdownText ? ` Per-account: ${accountBreakdownText}.` : ""} Snapshot characters (${importedCharacterLabels.length}): ${importedPreview}${importedCharacterLabels.length > 12 ? ", ..." : ""}.${missingKnownCharacters.length ? ` Nova characters not present in this inventory snapshot (${missingKnownCharacters.length}): ${missingPreview}${missingKnownCharacters.length > 12 ? ", ..." : ""}.` : ""}${warningSummary ? ` Validation warnings: ${warningSummary}.` : ""}`
      );
    } catch (error) {
      const diagnosticSummary = formatInventoryDiagnostics({
        ...syncDiagnostics,
        stage: syncStage
      });
      if (integrityReport.status === "in-progress") {
        integrityReport.status = "failed";
        integrityReport.stage = syncStage;
        integrityReport.reason = error?.message || "Sync failed.";
        integrityReport.warnings = [];
        integrityReport.unresolvedProfiles = syncDiagnostics.unresolvedProfiles;
        integrityReport.unresolvedItems = syncDiagnostics.unresolvedItems;
        setBagnonIntegrityReport(integrityReport);
        updateInventorySyncHistory({
          accountLabels: integrityReport.indexedAccountLabels,
          status: integrityReport.status,
          stage: integrityReport.stage,
          reason: integrityReport.reason,
          unresolvedProfiles: integrityReport.unresolvedProfiles,
          unresolvedItems: integrityReport.unresolvedItems,
          totals: integrityReport.totals,
          warnings: integrityReport.warnings
        });
      }
      setBagnonSyncMessage(
        `${error?.message || "Sync failed."} Diagnostics: ${diagnosticSummary || "none"}.`
      );
    } finally {
      setIsBagnonSyncing(false);
    }
  };

  const loadSelectedNovaSources = async (allowedAccountLabels = []) => {
    const handles = await loadConnectedHandles();
    const selectedIndexes = readSelectedFileIndexes();
    const meta = readConnectedFileMeta();
    const selectedHandleEntries = selectedIndexes.length
      ? selectedIndexes
        .map((index) => ({ handle: handles[index], sourceIndex: index }))
        .filter((entry) => Boolean(entry.handle))
      : handles.map((handle, sourceIndex) => ({ handle, sourceIndex }));
    const allowedAccounts = new Set((allowedAccountLabels || []).map((label) => normalize(label)));

    const sources = [];
    for (const entry of selectedHandleEntries) {
      const handle = entry.handle;
      const accountHintName = String(meta[entry.sourceIndex]?.accountName || "").trim();
      const accountLabel = accountHintName || "(unlabeled account)";
      if (allowedAccounts.size && !allowedAccounts.has(normalize(accountLabel))) {
        continue;
      }

      let permission = "granted";
      if (handle.queryPermission) {
        permission = await handle.queryPermission({ mode: "read" });
      }
      if (permission !== "granted") {
        permission = await handle.requestPermission({ mode: "read" });
      }
      if (permission !== "granted") {
        throw new Error("permission-denied");
      }

      const file = await handle.getFile();
      sources.push({
        text: await file.text(),
        fileName: file.name,
        accountHintName
      });
    }

    return sources;
  };

  const loadSelectedBagnonSources = async (allowedAccountLabels = []) => {
    const handles = await loadBagnonConnectedHandles();
    const selectedIndexes = readBagnonSelectedFileIndexes();
    const meta = readBagnonConnectedFileMeta();
    const selectedHandleEntries = selectedIndexes.length
      ? selectedIndexes
        .map((index) => ({ handle: handles[index], sourceIndex: index }))
        .filter((entry) => Boolean(entry.handle))
      : handles.map((handle, sourceIndex) => ({ handle, sourceIndex }));
    const allowedAccounts = new Set((allowedAccountLabels || []).map((label) => normalize(label)));

    const sources = [];
    for (const entry of selectedHandleEntries) {
      const handle = entry.handle;
      const accountHintName = String(meta[entry.sourceIndex]?.accountName || "").trim();
      const accountLabel = accountHintName || "(unlabeled account)";
      if (allowedAccounts.size && !allowedAccounts.has(normalize(accountLabel))) {
        continue;
      }

      let permission = "granted";
      if (handle.queryPermission) {
        permission = await handle.queryPermission({ mode: "read" });
      }
      if (permission !== "granted") {
        permission = await handle.requestPermission({ mode: "read" });
      }
      if (permission !== "granted") {
        throw new Error("permission-denied");
      }

      const file = await handle.getFile();
      sources.push({
        text: await file.text(),
        accountHintName,
        fileName: file.name
      });
    }

    return sources;
  };

  const onConnectBagnonFiles = async () => {
    if (!window.showOpenFilePicker) {
      setBagnonSyncMessage("Your browser does not support direct file connections. Use Update and pick files.");
      return;
    }

    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: "Lua files",
            accept: {
              "text/plain": [".lua"]
            }
          }
        ]
      });

      if (!handles.length) {
        return;
      }

      const defaultAccountLabel = getDefaultAccountLabel(data.accounts, user?.email);
      setPendingBagnonConnectHandles(handles);
      setPendingBagnonAccountName(
        getUniqueAccountHint(bagnonPaths)
        || getUniqueAccountHint(bagnonConnectedFiles.map((item) => item.accountName))
        || defaultAccountLabel
      );
      setBagnonSyncMessage("Select or type an account for the new files, then confirm.");
    } catch {
      // User cancelled picker.
    }
  };

  const onCancelPendingBagnonConnect = () => {
    setPendingBagnonConnectHandles([]);
    setPendingBagnonAccountName("");
  };

  const onConfirmPendingBagnonConnect = async () => {
    if (!pendingBagnonConnectHandles.length) {
      return;
    }

    try {
      const defaultAccountLabel = getDefaultAccountLabel(data.accounts, user?.email);
      const accountHintName = pendingBagnonAccountName.trim() || defaultAccountLabel;
      const existingHandles = await loadBagnonConnectedHandles();
      const existingMeta = readBagnonConnectedFileMeta();

      const merged = await mergeBagnonConnectedHandles(existingHandles, pendingBagnonConnectHandles);
      const addedCount = merged.length - existingHandles.length;
      const nextMeta = [...existingMeta];
      for (let index = 0; index < addedCount; index += 1) {
        nextMeta.push({ accountName: accountHintName, fileName: pendingBagnonConnectHandles[index]?.name || "" });
      }

      await saveBagnonConnectedHandles(merged);
      saveBagnonConnectedFileMeta(nextMeta);
      setBagnonConnectedFiles(buildBagnonConnectedFileEntries(merged, nextMeta));
      saveBagnonSelectedFileIndexes(merged.map((_, index) => index));
      if (accountHintName) {
        saveBagnonPaths([accountHintName]);
      }
      setBagnonSyncMessage(
        `Added ${pendingBagnonConnectHandles.length} file selection(s). ${merged.length} inventory file(s) now connected.`
      );
      setPendingBagnonConnectHandles([]);
      setPendingBagnonAccountName("");
    } catch {
      setBagnonSyncMessage("Could not connect selected files. Try again.");
    }
  };

  const onReconnectBagnonConnectedFile = async (index) => {
    if (!window.showOpenFilePicker) {
      setBagnonSyncMessage("Your browser does not support direct file connections. Use Connect Inventory Files and pick files.");
      return;
    }

    try {
      const handles = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "Lua files",
            accept: {
              "text/plain": [".lua"]
            }
          }
        ]
      });

      if (!handles.length) {
        return;
      }

      const nextHandles = await loadBagnonConnectedHandles();
      nextHandles[index] = handles[0];
      const nextMeta = readBagnonConnectedFileMeta();
      nextMeta[index] = {
        accountName: bagnonConnectedFiles[index]?.accountName || nextMeta[index]?.accountName || "",
        fileName: handles[0].name || ""
      };

      await saveBagnonConnectedHandles(nextHandles);
      saveBagnonConnectedFileMeta(nextMeta);
      setBagnonConnectedFiles(buildBagnonConnectedFileEntries(nextHandles, nextMeta, readBagnonSelectedFileIndexes()));
      setBagnonSyncMessage(`Reconnected ${handles[0].name || "selected file"}.`);
    } catch {
      setBagnonSyncMessage("Could not reconnect the file. Try again.");
    }
  };

  const onUpdateFromBagnonConnectedFiles = async (silent = false) => {
    try {
      await onUpdateFromConnectedFiles(silent);
    } catch {
      if (!silent) {
        setBagnonSyncMessage("Could not read selected connected files. Reconnect files and try again.");
      }
    }
  };

  const onToggleBagnonConnectedFile = (id, checked) => {
    setBagnonConnectedFiles((prev) => {
      const next = prev.map((item) => (item.id === id ? { ...item, selected: checked } : item));
      const selectedIndexes = next
        .map((item, index) => (item.selected ? index : -1))
        .filter((value) => value >= 0);
      saveBagnonSelectedFileIndexes(selectedIndexes);
      return next;
    });
  };

  const onChangeBagnonConnectedFileAccountName = async (id, accountName) => {
    const next = bagnonConnectedFiles.map((item) => (
      item.id === id
        ? { ...item, accountName }
        : item
    ));

    setBagnonConnectedFiles(next);
    try {
      await saveBagnonConnectedHandles(next.map((item) => item.handle));
      saveBagnonConnectedFileMeta(
        next.map((item) => ({
          accountName: String(item.accountName || "").trim(),
          fileName: item.fileName || item.name || ""
        }))
      );
    } catch {
      setBagnonSyncMessage("Could not update account label for the connected inventory file.");
    }
  };

  const onApplyBulkBagnonAccountName = async () => {
    const value = bulkBagnonAccountName.trim();
    if (!value) {
      setBagnonSyncMessage("Type an account label to apply to selected inventory files.");
      return;
    }

    const selectedCount = bagnonConnectedFiles.filter((item) => item.selected).length;
    if (!selectedCount) {
      setBagnonSyncMessage("Select at least one inventory file to apply bulk account label.");
      return;
    }

    const next = bagnonConnectedFiles.map((item) => (
      item.selected ? { ...item, accountName: value } : item
    ));
    setBagnonConnectedFiles(next);

    try {
      await saveBagnonConnectedHandles(next.map((item) => item.handle));
      saveBagnonConnectedFileMeta(
        next.map((item) => ({
          accountName: String(item.accountName || "").trim(),
          fileName: item.fileName || item.name || ""
        }))
      );
      setBagnonSyncMessage(`Applied account label \"${value}\" to ${selectedCount} selected inventory file(s).`);
    } catch {
      setBagnonSyncMessage("Could not apply bulk account label to selected inventory files.");
    }
  };

  const onClearBagnonInventory = async () => {
    if (!window.confirm("Clear synced inventory data for your account? You can re-sync at any time.")) {
      return;
    }

    setIsClearingInventory(true);
    try {
      await clearInventoryData(user.uid);
      setBagnonSyncMessage("Inventory data cleared.");
    } catch {
      setBagnonSyncMessage("Could not clear inventory data. Try again.");
    } finally {
      setIsClearingInventory(false);
    }
  };

  const onRemoveBagnonConnectedFile = async (id) => {
    const next = bagnonConnectedFiles.filter((item) => item.id !== id);
    setBagnonConnectedFiles(next);
    await saveBagnonConnectedHandles(next.map((item) => item.handle));
    saveBagnonConnectedFileMeta(
      next.map((item) => ({ accountName: item.accountName || "", fileName: item.fileName || item.name || "" }))
    );
    const selectedIndexes = next
      .map((item, index) => (item.selected ? index : -1))
      .filter((value) => value >= 0);
    saveBagnonSelectedFileIndexes(selectedIndexes);
    setBagnonSyncMessage(`Connected file removed. ${next.length} remaining.`);
  };

  const onReconnectConnectedFile = async (index) => {
    if (!window.showOpenFilePicker) {
      setSyncMessage("Your browser does not support direct file connections. Use Connect Nova and pick files.");
      return;
    }

    try {
      const handles = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "Lua files",
            accept: {
              "text/plain": [".lua"]
            }
          }
        ]
      });

      if (!handles.length) {
        return;
      }

      const nextHandles = await loadConnectedHandles();
      nextHandles[index] = handles[0];
      const nextMeta = readConnectedFileMeta();
      nextMeta[index] = {
        accountName: connectedFiles[index]?.accountName || nextMeta[index]?.accountName || "",
        fileName: handles[0].name || ""
      };

      await saveConnectedHandles(nextHandles);
      saveConnectedFileMeta(nextMeta);
      setConnectedFiles(buildConnectedFileEntries(nextHandles, nextMeta, readSelectedFileIndexes()));
      setSyncMessage(`Reconnected ${handles[0].name || "selected file"}.`);
    } catch {
      setSyncMessage("Could not reconnect the file. Try again.");
    }
  };

  const onUpdateFromConnectedFiles = async (silent = false) => {
    try {
      const [novaSources, bagnonSources] = await Promise.all([
        loadSelectedNovaSources(selectedNovaSyncAccounts),
        loadSelectedBagnonSources(selectedInventorySyncAccounts)
      ]);

      if (!novaSources.length && !bagnonSources.length) {
        if (!silent) {
          setSyncMessage("No connected files matched your selected sync-account filters.");
        }
        return;
      }

      if (novaSources.length) {
        await syncFromLuaTexts(novaSources);
      }

      if (bagnonSources.length) {
        const missingInventorySources = getMissingExpectedFilesFromSources(
          bagnonSources,
          INVENTORY_EXPECTED_FILES
        );
        const missingInventorySourcesByAccount = getMissingExpectedFilesByAccountFromSources(
          bagnonSources,
          INVENTORY_EXPECTED_FILES
        );
        if (missingInventorySources.length || missingInventorySourcesByAccount.length) {
          const selectedInventoryFiles = bagnonSources
            .map((source) => source.fileName)
            .filter(Boolean)
            .join(", ");
          const missingByAccountSummary = missingInventorySourcesByAccount
            .map((entry) => `${entry.accountLabel}: ${entry.missing.join(", ")}`)
            .join(" | ");
          const missingReason = missingInventorySourcesByAccount.length
            ? `Missing required selected inventory file(s) by account: ${missingByAccountSummary}`
            : `Missing required selected inventory file(s): ${missingInventorySources.join(", ")}`;
          setBagnonIntegrityReport({
            status: "failed",
            stage: "pre-parse-validation",
            reason: missingReason,
            totals: {
              itemStacks: 0,
              totalItemQuantity: 0,
              uniqueItems: 0,
              ownersWithItems: 0,
              snapshotCharacters: 0,
              equipmentProfiles: 0,
              characterProfiles: 0
            },
            sourceBreakdown: {
              containers: 0,
              inventory: 0,
              characters: 0,
              core: 0,
              unknown: 0
            },
            files: bagnonSources.map((source) => ({
              fileName: source.fileName || "",
              sourceType: detectDataStoreSourceType(source.fileName || "", source.text || ""),
              parsedCount: 0
            })),
            unresolvedProfiles: 0,
            unresolvedItems: 0,
            indexedAccountLabels: Array.from(new Set(bagnonSources.map((source) => source.accountHintName || "(unlabeled account)"))),
            accountBreakdown: [],
            warnings: missingInventorySourcesByAccount.length
              ? missingInventorySourcesByAccount.map((entry) => `Missing by account ${entry.accountLabel}: ${entry.missing.join(", ")}`)
              : []
          });
          const previousHistory = readInventorySyncHistory();
          const nextHistory = {
            ...previousHistory
          };
          const accountsForHistory = missingInventorySourcesByAccount.length
            ? missingInventorySourcesByAccount.map((entry) => entry.accountLabel)
            : Array.from(new Set(bagnonSources.map((source) => String(source.accountHintName || "").trim() || "(unlabeled account)")));
          accountsForHistory.forEach((accountLabel) => {
            nextHistory[accountLabel] = {
              accountLabel,
              lastRunAt: new Date().toISOString(),
              status: "failed",
              stage: "pre-parse-validation",
              reason: missingReason,
              unresolvedProfiles: 0,
              unresolvedItems: 0,
              totals: {
                itemStacks: 0,
                totalItemQuantity: 0,
                uniqueItems: 0,
                ownersWithItems: 0,
                snapshotCharacters: 0
              },
              warningsCount: missingInventorySourcesByAccount.length
            };
          });
          setInventorySyncHistoryByAccount(nextHistory);
          saveInventorySyncHistory(nextHistory);
          setBagnonSyncMessage(
            `Sync blocked before parse. ${missingReason}. Selected now: ${selectedInventoryFiles || "none"}. If a file is connected but unchecked, tick it under Connected Inventory Files.`
          );
          return;
        }
        await syncBagnonFromLuaTexts(bagnonSources);
      }
    } catch {
      if (!silent) {
        setSyncMessage("Could not read selected connected files. Reconnect files and try again.");
      }
    }
  };

  const onToggleConnectedFile = (id, checked) => {
    setConnectedFiles((prev) => {
      const next = prev.map((item) => (item.id === id ? { ...item, selected: checked } : item));
      const selectedIndexes = next
        .map((item, index) => (item.selected ? index : -1))
        .filter((value) => value >= 0);
      saveSelectedFileIndexes(selectedIndexes);
      return next;
    });
  };

  const onChangeConnectedFileAccountName = async (id, accountName) => {
    const next = connectedFiles.map((item) => (
      item.id === id
        ? { ...item, accountName }
        : item
    ));

    setConnectedFiles(next);
    try {
      await saveConnectedHandles(next.map((item) => item.handle));
      saveConnectedFileMeta(
        next.map((item) => ({
          accountName: String(item.accountName || "").trim(),
          fileName: item.fileName || item.name || ""
        }))
      );
    } catch {
      setSyncMessage("Could not update account label for the connected Nova file.");
    }
  };

  const onApplyBulkNovaAccountName = async () => {
    const value = bulkNovaAccountName.trim();
    if (!value) {
      setSyncMessage("Type an account label to apply to selected Nova files.");
      return;
    }

    const selectedCount = connectedFiles.filter((item) => item.selected).length;
    if (!selectedCount) {
      setSyncMessage("Select at least one Nova file to apply bulk account label.");
      return;
    }

    const next = connectedFiles.map((item) => (
      item.selected ? { ...item, accountName: value } : item
    ));
    setConnectedFiles(next);

    try {
      await saveConnectedHandles(next.map((item) => item.handle));
      saveConnectedFileMeta(
        next.map((item) => ({
          accountName: String(item.accountName || "").trim(),
          fileName: item.fileName || item.name || ""
        }))
      );
      setSyncMessage(`Applied account label \"${value}\" to ${selectedCount} selected Nova file(s).`);
    } catch {
      setSyncMessage("Could not apply bulk account label to selected Nova files.");
    }
  };

  const onToggleNovaSyncAccount = (accountLabel, checked) => {
    setSelectedNovaSyncAccounts((prev) => {
      if (checked) {
        return prev.includes(accountLabel) ? prev : [...prev, accountLabel];
      }
      return prev.filter((value) => value !== accountLabel);
    });
  };

  const onToggleInventorySyncAccount = (accountLabel, checked) => {
    setSelectedInventorySyncAccounts((prev) => {
      if (checked) {
        return prev.includes(accountLabel) ? prev : [...prev, accountLabel];
      }
      return prev.filter((value) => value !== accountLabel);
    });
  };

  const onRemoveConnectedFile = async (id) => {
    const next = connectedFiles.filter((item) => item.id !== id);
    setConnectedFiles(next);
    await saveConnectedHandles(next.map((item) => item.handle));
    saveConnectedFileMeta(
      next.map((item) => ({ accountName: item.accountName || "", fileName: item.fileName || item.name || "" }))
    );
    const selectedIndexes = next
      .map((item, index) => (item.selected ? index : -1))
      .filter((value) => value >= 0);
    saveSelectedFileIndexes(selectedIndexes);
    setSyncMessage(`Connected file removed. ${next.length} remaining.`);
  };

  const onToggleDashboardVisibility = async (characterId, checked) => {
    setSavingCharacterId(characterId);
    try {
      await updateCharacter(characterId, { showOnDashboard: checked });
    } finally {
      setSavingCharacterId("");
    }
  };

  const onChangeActiveRaidTag = async (characterId, activeRaidTag) => {
    setSavingCharacterId(characterId);
    try {
      await updateCharacter(characterId, { activeRaidTag });
    } finally {
      setSavingCharacterId("");
    }
  };

  const onDeleteAllData = async () => {
    if (!user || isDeletingAll) {
      return;
    }

    const confirmed = window.confirm(
      "Delete ALL your app data (accounts, characters, loot, and raid lockouts)? This cannot be undone."
    );
    if (!confirmed) {
      return;
    }

    setIsDeletingAll(true);
    setSyncMessage("Deleting all data...");
    try {
      await deleteAllUserData(user.uid);
      await clearInventoryData(user.uid);
      localStorage.removeItem(NIT_PATHS_KEY);
      localStorage.removeItem(BAGNON_PATHS_KEY);
      localStorage.removeItem(NOVA_SYNC_ACCOUNT_FILTERS_KEY);
      localStorage.removeItem(INVENTORY_SYNC_ACCOUNT_FILTERS_KEY);
      await saveConnectedHandles([]);
      await saveBagnonConnectedHandles([]);
      setNitPaths([]);
      setBagnonPaths([]);
      setConnectedFiles([]);
      setBagnonConnectedFiles([]);
      setSelectedNovaSyncAccounts([]);
      setSelectedInventorySyncAccounts([]);
      saveSelectedFileIndexes([]);
      saveBagnonSelectedFileIndexes([]);
      setSyncMessage("All data deleted.");
    } catch {
      setSyncMessage("Delete failed. Please try again.");
    } finally {
      setIsDeletingAll(false);
    }
  };

  const onDownloadBagnonIntegrityReport = () => {
    if (!bagnonIntegrityReport) {
      return;
    }

    const exportPayload = {
      generatedAt: new Date().toISOString(),
      selectedInventorySyncAccounts,
      report: bagnonIntegrityReport
    };
    downloadJsonFile("inventory-integrity-report.json", exportPayload);
  };

  return (
    <section className="panel">
      <h2>Settings</h2>
      <p className="subtitle">Manage file connections, sync, and account controls.</p>

      {!hasFirebaseConfig ? (
        <p className="empty-panel">Firebase env vars are missing. Copy .env.example into .env.local.</p>
      ) : user ? (
        <div className="stack-form">
          <p>
            Signed in as <strong>{user.email}</strong>
          </p>

          <div className="panel import-guide-panel minimal-settings-panel">
            <div className="row-actions minimal-settings-header">
              <h3>Setup</h3>
              <button type="button" className="secondary-btn" onClick={validateRequiredFiles}>
                Check required files
              </button>
            </div>
            <p className="subtitle">
              Linked: {novaLinkedSummary.linkedCount + inventoryLinkedSummary.linkedCount}/
              {NOVA_EXPECTED_FILES.length + INVENTORY_EXPECTED_FILES.length} required files.
            </p>
            {requiredFilesCheckMessage ? (
              <p className={`subtitle ${requiredFilesCheckRun ? "setup-check-result" : ""}`}>
                {requiredFilesCheckMessage}
              </p>
            ) : null}

            <details className="setup-guide-accordion">
              <summary>What to connect (expand guide)</summary>
              <div className="import-guide-grid">
                <article className="import-guide-card">
                  <h4>Nova: raids + buffs</h4>
                  <ul className="import-file-checklist">
                    {novaLinkedSummary.expectedStates.map((entry) => (
                      <li
                        key={entry.fileName}
                        className={`import-file-item ${entry.linked ? "linked" : "missing"}${requiredFilesCheckRun && !entry.linked ? " needs-attention" : ""}`}
                      >
                        <span>{entry.fileName}</span>
                        <span className={`import-status-chip ${entry.linked ? "ready" : "missing"}`}>
                          {entry.linked ? "Linked" : "Missing"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>

                <article className="import-guide-card">
                  <h4>DataStore: inventory + gear</h4>
                  <ul className="import-file-checklist">
                    {inventoryLinkedSummary.expectedStates.map((entry) => (
                      <li
                        key={entry.fileName}
                        className={`import-file-item ${entry.linked ? "linked" : "missing"}${requiredFilesCheckRun && !entry.linked ? " needs-attention" : ""}`}
                      >
                        <span>{entry.fileName}</span>
                        <span className={`import-status-chip ${entry.linked ? "ready" : "missing"}`}>
                          {entry.linked ? "Linked" : "Missing"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>
              </div>
            </details>
          </div>

          <div className="panel sync-panel">
            <h3>Nova Sync</h3>
            {!novaLinkedSummary.allLinked ? (
              <p className="sync-warning">Missing required Nova file links.</p>
            ) : null}
            <div className="row-actions">
              <button type="button" onClick={onConnectFiles} disabled={isSyncing}>
                Connect Nova Files
              </button>
              <button type="button" onClick={onUpdateFromConnectedFiles} disabled={isSyncing}>
                {isSyncing ? "Syncing..." : "Sync Connected Files"}
              </button>
            </div>
            <h4>Sync Accounts (Optional Filter)</h4>
            <p className="subtitle">If none are checked, all selected Nova files are synced.</p>
            {novaAccountOptions.length ? (
              <div className="row-actions">
                {novaAccountOptions.map((accountLabel) => (
                  <label key={accountLabel} className="saved-toggle">
                    <input
                      type="checkbox"
                      checked={selectedNovaSyncAccounts.includes(accountLabel)}
                      onChange={(event) => onToggleNovaSyncAccount(accountLabel, event.target.checked)}
                    />
                    {accountLabel}
                  </label>
                ))}
                <button type="button" className="secondary-btn" onClick={() => setSelectedNovaSyncAccounts([])}>
                  Clear Filter
                </button>
              </div>
            ) : (
              <p className="subtitle">No Nova account labels available yet.</p>
            )}
            <h4>Connected Nova Files</h4>
            <p className="subtitle">Each connected file can have its own account label.</p>
            <div className="row-actions">
              <input
                list="account-options"
                value={bulkNovaAccountName}
                onChange={(event) => setBulkNovaAccountName(event.target.value)}
                placeholder="Bulk account label for selected Nova files"
              />
              <button type="button" className="secondary-btn" onClick={onApplyBulkNovaAccountName}>
                Apply To Selected
              </button>
            </div>
            <ul className="simple-list">
              {connectedFiles.length ? (
                connectedFiles.map((item) => (
                  <li key={item.id}>
                    <label className="saved-toggle">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={(event) => onToggleConnectedFile(item.id, event.target.checked)}
                      />
                      {item.name}{item.accountName ? ` (${item.accountName})` : ""}
                    </label>
                    <input
                      value={item.accountName || ""}
                      onChange={(event) => onChangeConnectedFileAccountName(item.id, event.target.value)}
                      placeholder="Account label"
                    />
                    <div className="row-actions">
                      <button type="button" className="secondary-btn" onClick={() => onReconnectConnectedFile(connectedFiles.findIndex((entry) => entry.id === item.id))}>
                        Reconnect
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => onRemoveConnectedFile(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))
              ) : (
                <li>No connected files yet. Click Connect Nova once.</li>
              )}
            </ul>
            {syncMessage ? <p>{syncMessage}</p> : null}

            {pendingConnectHandles.length ? (
              <div className="panel">
                <h4>Set Account For New Files</h4>
                <p className="subtitle">
                  {pendingConnectHandles.length} selected file(s) awaiting confirmation.
                </p>
                <input
                  list="account-options"
                  value={pendingAccountName}
                  onChange={(event) => setPendingAccountName(event.target.value)}
                  placeholder="Type or select account"
                />
                <datalist id="account-options">
                  {data.accounts.map((account) => (
                    <option key={account.id} value={account.battleNetId} />
                  ))}
                </datalist>
                <div className="row-actions">
                  <button type="button" onClick={onConfirmPendingConnect}>
                    Confirm Connection
                  </button>
                  <button type="button" className="secondary-btn" onClick={onCancelPendingConnect}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="panel sync-panel">
            <h3>Inventory Sync</h3>
            {!inventoryLinkedSummary.allLinked ? (
              <p className="sync-warning">Missing required inventory file links.</p>
            ) : null}
            <div className="row-actions">
              <button type="button" onClick={onConnectBagnonFiles} disabled={isBagnonSyncing}>
                Connect Inventory Files
              </button>
              <button type="button" onClick={onUpdateFromBagnonConnectedFiles} disabled={isBagnonSyncing}>
                {isBagnonSyncing ? "Syncing..." : "Sync Connected Files"}
              </button>
              <button type="button" className="danger" onClick={onClearBagnonInventory} disabled={isClearingInventory || isBagnonSyncing}>
                {isClearingInventory ? "Clearing..." : "Clear Inventory Data"}
              </button>
            </div>
            <h4>Sync Accounts (Optional Filter)</h4>
            <p className="subtitle">If none are checked, all selected inventory files are synced.</p>
            {inventoryAccountOptions.length ? (
              <div className="row-actions">
                {inventoryAccountOptions.map((accountLabel) => (
                  <label key={accountLabel} className="saved-toggle">
                    <input
                      type="checkbox"
                      checked={selectedInventorySyncAccounts.includes(accountLabel)}
                      onChange={(event) => onToggleInventorySyncAccount(accountLabel, event.target.checked)}
                    />
                    {accountLabel}
                  </label>
                ))}
                <button type="button" className="secondary-btn" onClick={() => setSelectedInventorySyncAccounts([])}>
                  Clear Filter
                </button>
              </div>
            ) : (
              <p className="subtitle">No inventory account labels available yet.</p>
            )}
            <h4>Connected Inventory Files</h4>
            <p className="subtitle">Each connected file can have its own account label.</p>
            <div className="row-actions">
              <input
                list="account-options-bagnon"
                value={bulkBagnonAccountName}
                onChange={(event) => setBulkBagnonAccountName(event.target.value)}
                placeholder="Bulk account label for selected inventory files"
              />
              <button type="button" className="secondary-btn" onClick={onApplyBulkBagnonAccountName}>
                Apply To Selected
              </button>
            </div>
            <ul className="simple-list">
              {bagnonConnectedFiles.length ? (
                bagnonConnectedFiles.map((item) => (
                  <li key={item.id}>
                    <label className="saved-toggle">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={(event) => onToggleBagnonConnectedFile(item.id, event.target.checked)}
                      />
                      {item.name}{item.accountName ? ` (${item.accountName})` : ""}
                    </label>
                    <input
                      value={item.accountName || ""}
                      onChange={(event) => onChangeBagnonConnectedFileAccountName(item.id, event.target.value)}
                      placeholder="Account label"
                    />
                    <div className="row-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => onReconnectBagnonConnectedFile(bagnonConnectedFiles.findIndex((entry) => entry.id === item.id))}
                      >
                        Reconnect
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => onRemoveBagnonConnectedFile(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))
              ) : (
                <li>No connected files yet. Click Connect Inventory Files once.</li>
              )}
            </ul>
            {bagnonSyncMessage ? <p>{bagnonSyncMessage}</p> : null}
            {Object.keys(inventorySyncHistoryByAccount || {}).length ? (
              <div className="panel">
                <h4>Per-Account Sync History</h4>
                <ul className="simple-list">
                  {Object.values(inventorySyncHistoryByAccount)
                    .sort((a, b) => String(a.accountLabel || "").localeCompare(String(b.accountLabel || "")))
                    .map((entry) => (
                      <li key={entry.accountLabel}>
                        <strong>{entry.accountLabel}</strong>: {entry.status} at {entry.stage} on {entry.lastRunAt || "unknown"}.
                        {entry.reason ? ` Reason: ${entry.reason}.` : ""}
                        Totals: stacks {entry.totals?.itemStacks || 0}, count {entry.totals?.totalItemQuantity || 0}, unique {entry.totals?.uniqueItems || 0}.
                        Unresolved: profiles {entry.unresolvedProfiles || 0}, items {entry.unresolvedItems || 0}. Warnings: {entry.warningsCount || 0}.
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
            {bagnonIntegrityReport ? (
              <div className="panel">
                <h4>Inventory Integrity Report</h4>
                <div className="row-actions">
                  <button type="button" className="secondary-btn" onClick={onDownloadBagnonIntegrityReport}>
                    Download Report JSON
                  </button>
                </div>
                <p className="subtitle">
                  Status: {bagnonIntegrityReport.status} | Stage: {bagnonIntegrityReport.stage}
                </p>
                {bagnonIntegrityReport.reason ? (
                  <p className="subtitle">Reason: {bagnonIntegrityReport.reason}</p>
                ) : null}
                <p className="subtitle">
                  Totals: stacks {bagnonIntegrityReport.totals?.itemStacks || 0}, item count {bagnonIntegrityReport.totals?.totalItemQuantity || 0},
                  unique items {bagnonIntegrityReport.totals?.uniqueItems || 0}, owners with items {bagnonIntegrityReport.totals?.ownersWithItems || 0},
                  snapshot characters {bagnonIntegrityReport.totals?.snapshotCharacters || 0}, equipment profiles {bagnonIntegrityReport.totals?.equipmentProfiles || 0},
                  character profiles {bagnonIntegrityReport.totals?.characterProfiles || 0}.
                </p>
                <p className="subtitle">
                  Unresolved: profiles {bagnonIntegrityReport.unresolvedProfiles || 0}, items {bagnonIntegrityReport.unresolvedItems || 0}.
                </p>
                {Array.isArray(bagnonIntegrityReport.indexedAccountLabels) && bagnonIntegrityReport.indexedAccountLabels.length ? (
                  <p className="subtitle">
                    Indexed accounts: {bagnonIntegrityReport.indexedAccountLabels.join(", ")}.
                  </p>
                ) : null}
                {Array.isArray(bagnonIntegrityReport.accountBreakdown) && bagnonIntegrityReport.accountBreakdown.length ? (
                  <p className="subtitle">
                    Per-account: {bagnonIntegrityReport.accountBreakdown
                      .map((entry) => `${entry.accountName}: ${entry.ownersWithItems} owners / ${entry.snapshotCharacters} snapshot`)
                      .join(" | ")}.
                  </p>
                ) : null}
                {Array.isArray(bagnonIntegrityReport.files) && bagnonIntegrityReport.files.length ? (
                  <p className="subtitle">
                    Files: {bagnonIntegrityReport.files
                      .map((file) => `${file.fileName}:${file.sourceType}:${file.parsedCount}`)
                      .join(" | ")}.
                  </p>
                ) : null}
              </div>
            ) : null}

            {pendingBagnonConnectHandles.length ? (
              <div className="panel">
                <h4>Set Account For New Files</h4>
                <p className="subtitle">
                  {pendingBagnonConnectHandles.length} selected file(s) awaiting confirmation.
                </p>
                <input
                  list="account-options-bagnon"
                  value={pendingBagnonAccountName}
                  onChange={(event) => setPendingBagnonAccountName(event.target.value)}
                  placeholder="Type or select account"
                />
                <datalist id="account-options-bagnon">
                  {data.accounts.map((account) => (
                    <option key={account.id} value={account.battleNetId} />
                  ))}
                </datalist>
                <div className="row-actions">
                  <button type="button" onClick={onConfirmPendingBagnonConnect}>
                    Confirm Connection
                  </button>
                  <button type="button" className="secondary-btn" onClick={onCancelPendingBagnonConnect}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <h3>Character Tags & Visibility</h3>
            <p>Tag active raiders and control who appears on dashboard and inventory views.</p>
            <div className="dashboard-filters settings-character-filters">
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search name, realm, account, or raid tag"
              />
              <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
                <option value="all">All classes</option>
                {filterOptions.classOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <select value={realmFilter} onChange={(event) => setRealmFilter(event.target.value)}>
                <option value="all">All realms</option>
                {filterOptions.realmOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
                <option value="all">All accounts</option>
                {filterOptions.accountOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select value={visibilityFilter} onChange={(event) => setVisibilityFilter(event.target.value)}>
                <option value="all">All visibility</option>
                <option value="visible">Shown on dashboard</option>
                <option value="hidden">Hidden from dashboard</option>
              </select>
              <select value={activeRaidTagFilter} onChange={(event) => setActiveRaidTagFilter(event.target.value)}>
                <option value="all">All raid tags</option>
                <option value="tagged">Tagged only</option>
                <option value="untagged">Untagged only</option>
                {filterOptions.activeRaidTagOptions.map((option) => (
                  <option key={option} value={option}>
                    {resolveRaidTagLabel(option, RAIDS)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                step="1"
                value={minLevelFilter}
                onChange={(event) => setMinLevelFilter(event.target.value)}
                placeholder="Min level"
              />
            </div>
            {filteredCharacters.length ? (
              <ul className="simple-list">
                {filteredCharacters.map((character) => (
                  <li key={character.id}>
                    <span>
                      {character.name} - {character.realm} - {character.accountId
                        ? accountNameById.get(character.accountId) || "Unknown account"
                        : "Unassigned"} - L{character.level ?? "?"}
                      {character.activeRaidTag ? ` - ${resolveRaidTagLabel(character.activeRaidTag, RAIDS)}` : ""}
                    </span>
                    <div className="row-actions character-management-actions">
                      <select
                        value={character.activeRaidTag || ""}
                        disabled={savingCharacterId === character.id}
                        onChange={(event) => onChangeActiveRaidTag(character.id, event.target.value)}
                      >
                        <option value="">No raid tag</option>
                        {RAIDS.map((raid) => (
                          <option key={raid.name} value={raid.name}>
                            {raid.short} - {raid.name}
                          </option>
                        ))}
                      </select>
                      <label className="saved-toggle">
                        <input
                          type="checkbox"
                          checked={character.showOnDashboard !== false}
                          disabled={savingCharacterId === character.id}
                          onChange={(event) =>
                            onToggleDashboardVisibility(character.id, event.target.checked)
                          }
                        />
                        Show
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-panel">No characters match these settings filters.</p>
            )}
          </div>

          <div className="row-actions settings-account-actions">
            <button type="button" onClick={signOutUser}>
              Sign Out
            </button>
            <button
              type="button"
              className="danger"
              onClick={onDeleteAllData}
              disabled={isDeletingAll}
            >
              {isDeletingAll ? "Deleting..." : "Delete All Data"}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-form">
          <p>Sign in with Google to sync your characters and loot across devices.</p>
          <button type="button" onClick={signInWithGoogle}>
            Sign In with Google
          </button>
        </div>
      )}
    </section>
  );
}

export default SettingsPage;
