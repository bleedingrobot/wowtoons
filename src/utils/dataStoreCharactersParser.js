function parseCharacterKey(key) {
  const raw = String(key || "");
  const match = raw.match(/^Default\.([^\.]+)\.(.+)$/);
  if (!match) {
    return { realm: "", name: raw };
  }

  return {
    realm: match[1],
    name: match[2]
  };
}

function isCharacterTableKey(key) {
  return /^Default\.[^\.]+\..+/.test(String(key || ""));
}

function isAnonymousOpen(trimmed) {
  return /^\{\s*,?\s*$/.test(trimmed);
}

function isModernCharactersTable(trimmed) {
  return /^DataStore_Characters_Info\s*=\s*\{\s*,?\s*$/.test(trimmed);
}

function parseLuaValue(raw) {
  const value = String(raw || "")
    .replace(/--.*$/, "")
    .trim()
    .replace(/,$/, "");

  if (!value || value === "nil") {
    return null;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  const quoted = value.match(/^"([\s\S]*)"$/);
  if (quoted) {
    return quoted[1];
  }

  return value;
}

export function parseDataStoreCharacters(luaText, fileName = "", accountHintName = "") {
  const lines = String(luaText || "").split(/\r?\n/);
  const stack = [];
  const entries = [];

  const pushContext = (ctx) => {
    stack.push(ctx);
  };

  const closeContext = () => {
    const ctx = stack.pop();
    if (ctx?.type !== "character") {
      return;
    }

    if (!ctx.name && !Number.isInteger(ctx.characterIndex)) {
      return;
    }

    entries.push({
      characterName: ctx.name || "",
      realm: ctx.realm || "",
      characterIndex: ctx.characterIndex,
      accountHintName: String(accountHintName || "").trim(),
      sourceFileName: fileName,
      className: ctx.class || ctx.englishClass || "",
      race: ctx.race || ctx.englishRace || "",
      faction: ctx.localizedFaction || ctx.faction || "",
      level: typeof ctx.level === "number" ? ctx.level : null,
      money: typeof ctx.money === "number" ? ctx.money : null,
      zone: ctx.zone || "",
      subZone: ctx.subZone || "",
      bindLocation: ctx.bindLocation || "",
      guildName: ctx.guildName || "",
      guildRankName: ctx.guildRankName || "",
      guildRankIndex: typeof ctx.guildRankIndex === "number" ? ctx.guildRankIndex : null,
      isResting: typeof ctx.isResting === "boolean" ? ctx.isResting : null,
      played: typeof ctx.played === "number" ? ctx.played : null,
      playedThisLevel: typeof ctx.playedThisLevel === "number" ? ctx.playedThisLevel : null,
      xp: typeof ctx.XP === "number" ? ctx.XP : typeof ctx.xp === "number" ? ctx.xp : null,
      xpMax: typeof ctx.XPMax === "number" ? ctx.XPMax : typeof ctx.maxXP === "number" ? ctx.maxXP : null,
      restXp: typeof ctx.RestXP === "number" ? ctx.RestXP : typeof ctx.restXP === "number" ? ctx.restXP : null,
      lastCharacterUpdate: typeof ctx.lastUpdate === "number" ? ctx.lastUpdate : null,
      lastLogoutTimestamp: typeof ctx.lastLogoutTimestamp === "number" ? ctx.lastLogoutTimestamp : null
    });
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (isModernCharactersTable(trimmed)) {
      pushContext({
        type: "charactersInfoList",
        key: "DataStore_Characters_Info",
        nextCharacterIndex: 1
      });
      return;
    }

    const parent = stack[stack.length - 1];
    if (isAnonymousOpen(trimmed) && parent?.type === "charactersInfoList") {
      pushContext({
        type: "character",
        key: `index-${parent.nextCharacterIndex}`,
        characterIndex: parent.nextCharacterIndex,
        name: "",
        realm: ""
      });
      parent.nextCharacterIndex += 1;
      return;
    }

    const keyedOpen = trimmed.match(/^\[['"]([^'"]+)['"]\]\s*=\s*\{\s*,?\s*$/);
    if (keyedOpen) {
      const key = keyedOpen[1];
      const keyedParent = stack[stack.length - 1];

      if (!keyedParent && key === "global") {
        pushContext({ type: "global", key });
        return;
      }

      if (keyedParent?.type === "global" && key === "Characters") {
        pushContext({ type: "characters", key });
        return;
      }

      if (keyedParent?.type === "characters") {
        const parsed = parseCharacterKey(key);
        pushContext({
          type: "character",
          key,
          name: parsed.name,
          realm: parsed.realm
        });
        return;
      }

      if (!keyedParent && isCharacterTableKey(key)) {
        const parsed = parseCharacterKey(key);
        pushContext({
          type: "character",
          key,
          name: parsed.name,
          realm: parsed.realm
        });
        return;
      }

      pushContext({ type: "object", key });
      return;
    }

    const charCtx = [...stack].reverse().find((entry) => entry.type === "character");
    if (charCtx) {
      const keyedValueMatch = trimmed.match(/^\[['"]([^'"]+)['"]\]\s*=\s*(.+?)(?:,)?$/);
      if (keyedValueMatch) {
        const field = keyedValueMatch[1];
        const value = parseLuaValue(keyedValueMatch[2]);
        charCtx[field] = value;
      }
    }

    const closes = (trimmed.match(/}/g) || []).length;
    for (let index = 0; index < closes; index += 1) {
      if (stack.length) {
        closeContext();
      }
    }
  });

  return entries;
}
