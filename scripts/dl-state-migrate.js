#!/usr/bin/env node
// dl-state-migrate.js - Migrate ZOL's existing state files to the new durable store
//
// Usage: node scripts/dl-state-migrate.js [backup-id]
//
// This script:
// 1. Creates a backup of existing state at ~/.zol/state-backup-<backup-id>/
// 2. Reads existing JSON/seen files and imports them into the new store
// 3. Is idempotent and DOES NOT delete originals
// 4. Logs migration progress
//
// Example:
//   node scripts/dl-state-migrate.js 001
//   -> creates ~/.zol/state-backup-001/ with copies of all existing state files
//   -> imports them into the durable store
//   -> existing files remain untouched

const fs = require('fs');
const path = require('path');
const { createStateStore } = require('../src/state-adapter');

const H = process.env.HOME || '/root';
const ZOL_HOME = path.join(H, 'zol');
const BACKUP_ID = process.argv[2] || 'manual-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
const BACKUP_DIR = path.join(H, 'zol', `state-backup-${BACKUP_ID}`);

const MIGRATION_MAP = [
  { src: path.join(H, '.reply-seen'), store: 'seen-replies', parser: (content) => ({ hashes: content.split('\n').filter(Boolean) }) },
  { src: path.join(H, '.threads-seen'), store: 'seen-threads', parser: (content) => ({ ids: content.split('\n').filter(Boolean) }) },
  { src: path.join(ZOL_HOME, 'recent-casts.json'), store: 'recent-casts', parser: (content) => JSON.parse(content) },
  { src: path.join(ZOL_HOME, 'bot-blocklist.json'), store: 'bot-blocklist', parser: (content) => JSON.parse(content) },
  { src: path.join(ZOL_HOME, 'zol-persona.md'), store: 'persona-text', parser: (content) => ({ text: content }) },
];

const DRAFTS_DIR = path.join(ZOL_HOME, 'drafts');

async function backup() {
  console.log(`[Migration] Creating backup at ${BACKUP_DIR}`);
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });

  // Backup individual files
  for (const { src } of MIGRATION_MAP) {
    if (fs.existsSync(src)) {
      const filename = path.basename(src);
      const dest = path.join(BACKUP_DIR, filename);
      await fs.promises.copyFile(src, dest);
      console.log(`  [Backup] ${filename}`);
    }
  }

  // Backup drafts directory
  if (fs.existsSync(DRAFTS_DIR)) {
    const backupDraftsDir = path.join(BACKUP_DIR, 'drafts');
    await fs.promises.mkdir(backupDraftsDir, { recursive: true });
    const files = await fs.promises.readdir(DRAFTS_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const src = path.join(DRAFTS_DIR, file);
        const dest = path.join(backupDraftsDir, file);
        await fs.promises.copyFile(src, dest);
      }
    }
    console.log(`  [Backup] drafts/ (${files.filter((f) => f.endsWith('.json')).length} files)`);
  }

  console.log(`[Migration] Backup complete. Original files unchanged.\n`);
}

async function migrate() {
  const store = await createStateStore();

  console.log(`[Migration] Migrating existing state to ${store.name} backend\n`);

  // Migrate individual state files
  for (const { src, store: storeKey, parser } of MIGRATION_MAP) {
    if (!fs.existsSync(src)) {
      console.log(`  [Skip] ${storeKey} (file not found)`);
      continue;
    }

    try {
      const content = await fs.promises.readFile(src, 'utf8');
      const data = parser(content);
      await store.put(storeKey, data);
      console.log(`  [Migrated] ${storeKey} (${JSON.stringify(data).length} bytes)`);
    } catch (e) {
      console.error(`  [Error] ${storeKey}: ${e.message}`);
    }
  }

  // Migrate drafts
  if (fs.existsSync(DRAFTS_DIR)) {
    const files = await fs.promises.readdir(DRAFTS_DIR);
    const drafts = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fs.promises.readFile(path.join(DRAFTS_DIR, file), 'utf8');
        const draft = JSON.parse(content);
        drafts.push({ hash: file.replace('.json', ''), ...draft });
      } catch (e) {
        console.error(`  [Error reading draft] ${file}: ${e.message}`);
      }
    }
    if (drafts.length > 0) {
      await store.put('drafts', { items: drafts });
      console.log(`  [Migrated] drafts (${drafts.length} items)`);
    }
  }

  console.log(`\n[Migration] Complete. All state migrated to ${store.name} backend.`);
  console.log(`[Migration] Backup created at: ${BACKUP_DIR}`);
  console.log(`[Migration] Original files remain in place - safe to test the new backend.`);
  console.log(`[Migration] To restore from backup, use: node scripts/dl-state-restore.js ${BACKUP_ID}`);

  // Close SQLite connection if applicable
  if (store.close) store.close();
}

(async () => {
  try {
    await backup();
    await migrate();
  } catch (e) {
    console.error(`[Error] ${e.message}`);
    process.exit(1);
  }
})();
