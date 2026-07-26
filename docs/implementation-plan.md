# Implementation Plan: WoW Data Platform

## Objectives
- Build a web app hosted on GitHub Pages with Firebase backend.
- Import and normalize DataStore and Nova SavedVariables data.
- Preserve exact character identity mapping across all modules.
- Support pages for raid cooldowns, inventory search, gear, world buff profiles, and raid readiness.

## Non-Negotiable Data Integrity Rules
- Character identity must be account-scoped and deterministic.
- Indexed DataStore rows must resolve using the matching account DataStore.lua map.
- Never merge by name only when index and realm metadata are available.
- Keep both display name and normalized name for matching and UI.
- Store source snapshot metadata so every sync is auditable.

## Canonical Character Identity
- Primary key components:
  - sourceAccount
  - realm
  - characterName
- Secondary identity support:
  - characterGuid (when present)
  - normalizedName and normalizedRealm for matching

## Source Coverage and What We Extract
- DataStore.lua:
  - CharacterIDs List/Set, CharacterGUIDs, connected realms, guild maps.
- DataStore_Characters.lua:
  - Identity snapshots, level, money, zone, guild rank, xp/rest xp.
- DataStore_Inventory.lua:
  - Equipped item links and slot-level gear.
- DataStore_Containers.lua:
  - Bag/bank item ownership and stack counts.
- DataStore_Agenda.lua:
  - Saved lockouts, cooldown and reset hints.
- DataStore_Crafts.lua:
  - Professions, ranks, known crafts/reagents.
- DataStore_Talents.lua and DataStore_Spells.lua:
  - Talent and class spellbook context.
- NovaInstanceTracker.lua:
  - Character roster context, lockouts, raid activity.
- NovaWorldBuffs.lua:
  - Active/stored world buff state and timers.
- NovaRaidCompanion.lua:
  - Raid cooldown metadata.
- NovaConsumesHelper.lua:
  - Character consumable profile preferences.

## Required Pages
- Raid Cooldowns
- Inventory Search
- Gear View
- World Buff Profiles
- Raid Ready Lists

## Firebase Data Model (v1)
- users
- sourceSnapshots
- characters
- inventories
- equipment
- buffs
- raidLockouts
- readinessProfiles
- readinessResults

## Import Pipeline
1. Accept grouped file bundles per account.
2. Validate required files for each account.
3. Parse to raw module records.
4. Resolve identities using account-scoped index maps.
5. Run integrity checks.
6. Upsert normalized records to Firestore.
7. Persist sync metadata and diagnostics.

## Integrity Checks
- Hard fail:
  - Missing DataStore.lua for account with indexed rows.
  - Unresolved indexed rows after mapping.
- Warnings:
  - Character has profile but no container rows.
  - Character appears in Nova but not in DataStore snapshot.

## Milestones

### Milestone 1: Identity-First Import Foundation
- [ ] Finalize canonical identity helpers.
- [ ] Implement account-scoped DataStore index resolution.
- [ ] Add source snapshot metadata and import diagnostics.
- [ ] Add strict per-account required-file validation.
- [ ] Add integrity report output.

### Milestone 2: Inventory + Gear Core UX
- [ ] Inventory search page with owners and location totals.
- [ ] Gear page with slot-by-slot character equipment.
- [ ] Character detail drill-down (bags, bank, gear, profiles).

### Milestone 3: Raid + Buff Workflows
- [ ] Raid cooldown dashboard from Nova and DataStore lockouts.
- [ ] World buff profile builder by class/role.
- [ ] Buff compliance per character.

### Milestone 4: Raid Ready System
- [ ] Define consumable requirements by raid profile.
- [ ] Evaluate readiness from container inventory.
- [ ] Show missing consumables and ready/partial states.

### Milestone 5: Auditability + Reliability
- [ ] Snapshot history and rollback.
- [ ] Per-account sync coverage report.
- [ ] Regression tests for parser and identity mapping.

## Step-by-Step Execution Order
1. Lock identity rules and import contracts.
2. Build/verify importer with strict validation and diagnostics.
3. Wire Firestore schema and write services.
4. Build inventory search and gear views on normalized data.
5. Add raid cooldowns and world buff profile workflows.
6. Add raid-ready rule engine.
7. Add sync audits and regression tests.

## Working Agreement for This Project
- Implement one milestone task at a time.
- Build, test, and verify after each change.
- Keep data integrity checks strict and explicit.
- Never silently reassign unresolved data.
