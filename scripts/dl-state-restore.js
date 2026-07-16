#!/usr/bin/env node
// dl-state-restore.js - Restore ZOL state from a backup created by dl-state-migrate.js
//
// Usage: node scripts/dl-state-restore.js <backup-id>
//
// This script:
// 1. Reads state from a backup directory (~/.zol/state-backup-<id>/)
// 2. Imports it back into the durable store (replacing current state)
// 3. Creates a secondary backup before restore for safety
//
// Example:
//   node scripts/dl-state-restore.js 001
//   -> loads ~/.zol/state-backup-001/
//   -> creates ~/.zol/state-backup-pre-restore-001/ as safety backup
//   -> imports backed-up state into the durable store

const fs = require('fs');
const path = require('path');
const { createStateStore } = require('../src/state-adapter');

const H = process.env.HOME || '/root';
const ZOL_HOME = path.join(H, 'zol');
const BACKUP_ID = process.argv[2];

if (!BACKUP_ID) {
  console.error('Usage: node scripts/dl-state-restore.js <backup-id>');
  console.error('Example: node scripts/dl-state-restore.js 001');
  process.exit(1);
}

const BACKUP_DIR = path.join(H, 'zol', `state-backup-${BACKUP_ID}`);

if (!fs.existsSync(BACKUP_DIR)) {
  console.error(`[Error] Backup directory not found: ${BACKUP_DIR}`);
  process.exit(1);
}

async function createSafetyBackup() {
  const safetyId = `pre-restore-${BACKUP_ID}`;
  const safetyDir = path.join(H, 'zol', `state-backup-${safetyId}`);

  console.log(`[Restore] Creating safety backup at ${safetyDir}`);
  await fs.promises.mkdir(safetyDir, { recursive: true });

  const store = await createStateStore();
  const keys = await store.list();

  for (const key of keys) {
    try {
      const value = await store.get(key);
      const safePath = path.join(safetyDir, `${key}.json`);
      await fs.promises.writeFile(safePath, JSON.stringify(value, null, 2));
    } catch (e) {
      console.warn(`  [Warning] Could not backup ${key}: ${e.message}`);
    }
  }

  console.log(`  [Safety backup created] ${safetyDir}`);

  if (store.close) store.close();
}

async function restore() {
  const store = await createStateStore();

  console.log(`\n[Restore] Restoring state from backup: ${BACKUP_DIR}\n`);

  // Restore individual files
  const filesToRestore = ['.reply-seen', '.threads-seen', 'recent-casts.json', 'bot-blocklist.json', 'zol-persona.md'];
  const storeKeys = ['seen-replies', 'seen-threads', 'recent-casts', 'bot-blocklist', 'persona-text'];

  for (let i = 0; i < filesToRestore.length; i++) {
    const file = filesToRestore[i];
    const storeKey = storeKeys[i];
    const backupPath = path.join(BACKUP_DIR, file);

    if (!fs.existsSync(backupPath)) {
      console.log(`  [Skip] ${storeKey} (not in backup)`);
      continue;
    }

    try {
      const content = await fs.promises.readFile(backupPath, 'utf8');

      let data;
      if (storeKey === 'seen-replies' || storeKey === 'seen-threads') {
        data = { hashes: content.split('\n').filter(Boolean) };
      } else if (storeKey === 'persona-text') {
        data = { text: content };
      } else {
        data = JSON.parse(content);
      }

      await store.put(storeKey, data);
      console.log(`  [Restored] ${storeKey}`);
    } catch (e) {
      console.error(`  [Error] ${storeKey}: ${e.message}`);
    }
  }

  // Restore drafts
  const draftDir = path.join(BACKUP_DIR, 'drafts');
  if (fs.existsSync(draftDir)) {
    try {
      const files = await fs.promises.readdir(draftDir);
      const drafts = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const content = await fs.promises.readFile(path.join(draftDir, file), 'utf8');
        const draft = JSON.parse(content);
        drafts.push({ hash: file.replace('.json', ''), ...draft });
      }
      if (drafts.length > 0) {
        await store.put('drafts', { items: drafts });
        console.log(`  [Restored] drafts (${drafts.length} items)`);
      }
    } catch (e) {
      console.error(`  [Error restoring drafts] ${e.message}`);
    }
  }

  console.log(`\n[Restore] Complete. All state restored from backup.`);
  console.log(`[Restore] Safety backup created at: ${path.join(H, 'zol', `state-backup-pre-restore-${BACKUP_ID}`)}`);

  if (store.close) store.close();
}

(async () => {
  try {
    await createSafetyBackup();
    await restore();
  } catch (e) {
    console.error(`[Error] ${e.message}`);
    process.exit(1);
  }
})();
