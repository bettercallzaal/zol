# ZOL Pi Activation Runbook v1

**Audience:** Zaal (operator)  
**Context:** `~/zol` on the Pi is currently a directory of loose scripts (zol-reply, learn-zaal, threads), NOT a git clone. This runbook migrates to the bettercallzaal/zol repo and activates the full DreamLoops v2 framework.  
**Safety:** Run every step on the Pi manually. No automated deploy. Flag-OFF parity first.

---

## Prerequisites

| Item | Check |
|------|-------|
| GitHub access | `ssh -T git@github.com` → "Hi bettercallzaal!" |
| Node.js ≥ 20 | `node -v` → v20.x or higher |
| npm ≥ 10 | `npm -v` → 10.x or higher |
| Pi disk space | `df -h ~` → at least 500 MB free |
| Existing `.env` and credentials | `ls ~/.zao/private/` → neynar.env, openrouter.key, zol-state/ |

---

## Phase 1 — Clone and Install (10 minutes)

**Goal:** Get the repo onto the Pi without touching the existing `~/zol` directory.

```bash
# 1. Back up the existing loose scripts (DO NOT delete yet)
cp -r ~/zol ~/zol-backup-$(date +%Y%m%d)

# 2. Clone the v2 repo alongside the existing directory
git clone https://github.com/bettercallzaal/zol.git ~/zol-git

# 3. Install dependencies (no optional packages that require native builds)
cd ~/zol-git
npm install --ignore-scripts

# 4. Verify the install
node --check src/zol-lib.js 2>/dev/null && echo "syntax OK" || echo "zol-lib.js missing (expected on fresh clone — existing scripts still work)"
```

Expected: `syntax OK` — no errors about missing modules.  
If `@farcaster/hub-nodejs` warns about build: that's expected; it's lazy-loaded and won't block anything.

---

## Phase 2 — Run the Test Suite on the Pi (15 minutes)

**Goal:** Prove the 422-test suite passes on actual Pi hardware before touching crons.

```bash
cd ~/zol-git

# Run the full test suite
npm run dl:test 2>&1 | tail -12
```

Expected output (last lines):
```
# tests 452
# suites 51
# pass 452
# fail 0
# duration_ms ...
```

If any tests fail:
- Check `node -v` matches what CI uses (v20.x)
- Check that `~/.zao/private/` is readable by the running user
- Do NOT proceed to Phase 3 until all 452 pass

---

## Phase 3 — Validate Manifests and Secret Scan (5 minutes)

```bash
cd ~/zol-git

# Validate all 23 capsules and 72 loops
npm run dl:validate
# Expected: "validated 23 manifests" + "validated 72 manifests"

# Secret scan (must be clean before any cron wiring)
npm run dl:secret-scan
# Expected: "secret-scan: clean"
```

---

## Phase 4 — State Migration (5 minutes)

**Goal:** Carry the existing ZOL state (if any) into the new state directory format.

```bash
cd ~/zol-git

# Run the migration script (creates a backup, moves state to new format)
node scripts/dl-state-migrate.js
```

Expected: backup directory created at `~/.zao/private/zol-state-backup-<timestamp>`.  
If `~/.zao/private/zol-state/` is empty (fresh Pi), the script exits with "nothing to migrate" — that's OK.

---

## Phase 5 — Environment Config (3 minutes)

Add to `~/.zao/private/.env` (NOT committed to git):

```bash
# ZOL v2 DreamLoops config
ZOL_STATE_BACKEND=atomic-file
ZOL_STATE_DIR=/home/pi/.zao/private/zol-state
DREAMLOOPS_ENABLED=0        # <-- OFF for parity phase
ZOL_AGENT_GATEWAY_PORT=8089
WARPER_KEEPER_MODE=disabled
DREAMLOOPS_DAILY_BUDGET_TOKENS=20000
COWORK_TRACKER_URL=<your-supabase-url>
COWORK_TRACKER_KEY=<your-supabase-anon-key>
```

Verify:
```bash
grep DREAMLOOPS_ENABLED ~/.zao/private/.env
# Expected: DREAMLOOPS_ENABLED=0
```

---

## Phase 6 — Migrate the 3 Loose Scripts (20 minutes)

The three existing loose scripts are: `zol-reply`, `learn-zaal`, `threads`.  
They must continue to work unchanged while ZOL v2 runs alongside.

### 6a. zol-reply

```bash
# Verify the old script still works with the new zol-lib
cd ~/zol-git
node -e "const { ork } = require('./src/zol-lib'); console.log('zol-lib OK');"
```

Update any cron that calls `~/zol/zol-reply.js` to call `~/zol-git/scripts/zol-daily.js` instead — but ONLY after Phase 7 confirms parity.

### 6b. learn-zaal

This script reads Farcaster posts to build Zaal's context. In ZOL v2, this is replaced by the `weave-memory` DreamLoop. During parity phase, keep running the old script; disable it only after `DREAMLOOPS_ENABLED=1` and the first successful `weave-memory` run.

### 6c. threads

This script monitors thread replies. In ZOL v2, the `conversation-follow-up` DreamLoop handles this. Same migration approach as learn-zaal.

---

## Phase 7 — Parity Test: DREAMLOOPS_ENABLED=0 (flag-OFF)

**Goal:** Run ZOL v2 with DreamLoops disabled (flag-OFF) to confirm parity with the existing cron behavior. Existing crons remain active. No new loops fire.

```bash
cd ~/zol-git
source ~/.zao/private/.env   # DREAMLOOPS_ENABLED=0

# Dry-run the daily script (no posts, no state changes)
node scripts/dl-dry-run.js
```

Expected: all dry-run checks pass. No actual Farcaster posts made. No state written.

Run the old crons in parallel for at least 24 hours. Confirm:
- [ ] Existing `zol-reply` continues working as before
- [ ] No duplicate posts
- [ ] `~/zol-git` doesn't interfere with `~/zol`

---

## Phase 8 — Activate DreamLoops (DREAMLOOPS_ENABLED=1)

After Phase 7 parity is confirmed:

```bash
# In ~/.zao/private/.env:
sed -i 's/DREAMLOOPS_ENABLED=0/DREAMLOOPS_ENABLED=1/' ~/.zao/private/.env

# Verify
grep DREAMLOOPS_ENABLED ~/.zao/private/.env
# Expected: DREAMLOOPS_ENABLED=1
```

Then run the first live dry-run of all loops:
```bash
cd ~/zol-git
source ~/.zao/private/.env   # DREAMLOOPS_ENABLED=1
node scripts/dl-dry-run.js
```

Expected: 72 loops complete dry-run with no errors.

---

## Phase 9 — Wire Crons (via PR #20 systemd units or crontab)

PR #20 (`ws/pi-modernization`) provides systemd unit files. Alternatively, add to crontab:

```cron
# ZOL v2 DreamLoops (add AFTER Phase 7 parity period)
0 6 * * * cd /home/pi/zol-git && source ~/.zao/private/.env && node scripts/dl-dry-run.js >> ~/.zao/logs/zol-v2.log 2>&1

# Agent Gateway (optional — only if you need remote MCP access)
@reboot cd /home/pi/zol-git && source ~/.zao/private/.env && node src/agent-gateway.js >> ~/.zao/logs/gateway.log 2>&1 &
```

---

## Phase 10 — Health Check

After first live run:

```bash
# Check last receipt
ls -lt ~/.zao/private/zol-state/ | head -5

# Check agent gateway (if running)
curl http://localhost:8089/health
# Expected: {"status":"ok","capsules":23,"loops":72}

# Check secret scan (should always be clean)
cd ~/zol-git && npm run dl:secret-scan
```

---

## Rollback Procedure

If anything goes wrong:

```bash
# 1. Stop any ZOL v2 processes
pkill -f "zol-git" 2>/dev/null || true

# 2. Disable DreamLoops
sed -i 's/DREAMLOOPS_ENABLED=1/DREAMLOOPS_ENABLED=0/' ~/.zao/private/.env

# 3. Restore original crons (revert any cron changes made in Phase 9)

# 4. The original ~/zol-backup-<date> directory is untouched
# Existing crons pointing to ~/zol/ still work

# 5. State backup is at ~/.zao/private/zol-state-backup-<timestamp>
# To restore: cp -r ~/.zao/private/zol-state-backup-<timestamp> ~/.zao/private/zol-state
```

---

## Known Limitations

- `@farcaster/hub-nodejs` requires native build on Pi; `npm install --ignore-scripts` skips it. The hub functions (post/remove/follow) are lazy-loaded and still work if the package built successfully in a prior install.
- Agent Gateway binds to `localhost:8089` by default; remote access requires `ZOL_AGENT_GATEWAY_REMOTE=1` and an authenticated transport (see fleet standard).
- Warper Keeper is disabled by default; set `WARPER_KEEPER_MODE=mock` for local testing or `WARPER_KEEPER_MODE=remote` with a configured endpoint.
- ToolGym workouts are mock-blocked by default; set `TOOLGYM_MODE=live` only after reviewing the workout manifests.

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `npm run dl:test` | Run all 452 tests |
| `npm run dl:validate` | Validate 23 capsules + 72 loops |
| `npm run dl:secret-scan` | Secret scan (must be clean) |
| `npm run dl:dry-run` | Dry-run all loops (no state changes) |
| `npm run dl:dry-run:board` | Dry-run board-triage handlers |
| `node scripts/dl-state-migrate.js` | Migrate state (creates backup) |
| `curl localhost:8089/health` | Agent gateway health |

---

*Runbook version: v1.1 — 2026-07-17 (updated test/loop counts). No production changes occur until Zaal runs these steps manually on the Pi.*
