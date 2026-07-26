# Identity Contract: DataStore + Nova

## Purpose
Define deterministic rules that map every parsed record to exactly one canonical character.

## Canonical Key
- accountLabel
- realm
- characterName

Composite key format:
- normalizedAccount|normalizedRealm|normalizedCharacterName

## Normalization Rules
- trim whitespace
- lowercase for matching keys
- keep display values untouched for UI
- keep normalized variants for lookups

## Mapping Inputs
- DataStore.lua:
  - DataStore_CharacterIDs.List / Set
  - DataStore_CharacterGUIDs
  - DataStore_ConnectedRealms
- DataStore_Characters.lua / Inventory / Containers:
  - characterIndex and optional name/realm values
- Nova files:
  - explicit character name and realm

## Deterministic Resolution Order
1. If record has characterIndex and accountLabel:
   - resolve with that account's DataStore.lua map.
2. If record has explicit character name and realm:
   - use those fields directly.
3. If index exists but account map missing:
   - hard fail for that account import.
4. If name/realm still unresolved:
   - hard fail record and report diagnostics.

## Account Scoping Rule
- characterIndex is only meaningful within a single account snapshot.
- never resolve index values with another account's map.

## Connected Realm Rule
- preserve original realm in canonical key.
- optional realm-grouping for UI can use DataStore_ConnectedRealms.
- grouping must never replace canonical identity.

## Duplicate Name Handling
- same name across realms are separate characters.
- same name/realm across accounts are separate characters.

## GUID Handling
- when available, persist character GUID.
- GUID is an invariant attribute, not the sole key.

## Merge Rules Across Sources
- Containers defines bag/bank ownership rows.
- Inventory defines equipped gear rows.
- Characters defines profile snapshots.
- Nova defines raid/buff operational state.
- all merges happen after canonical identity resolution.

## Validation Requirements
Hard fail conditions:
- indexed records with missing DataStore.lua map for that account
- unresolved character identity after deterministic mapping

Warning conditions:
- character in Nova but absent from DataStore snapshot
- character has profile but no container rows

## Audit Output Requirements
Each sync should report:
- total indexed records by source
- unresolved records by source and account
- per-account owner count
- per-account snapshot character count
- list of Nova-only characters
