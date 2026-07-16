# ZOL Pi Modernization Kit

This directory contains a systemd-based modernization kit for running ZOL's long-running services on your Raspberry Pi via systemd instead of cron or manual invocation.

## What This Is

This is a **build-only, never-tested kit** - it provides systemd unit files and a migration script that **you must read and run yourself** on the Pi. This kit has never been executed against the actual Pi. It is provided as a template to modernize your Pi setup.

## Overview

Today, ZOL runs three long-running processes on `ansuz` (the Pi):

1. **zol-daily.js** - Hourly curator cast poster (5am-10pm ET schedule)
2. **zol-reply.js** - Always-on mention polling daemon  
3. **zol-calendar.js** - 15-minute calendar event detector

These have historically been started manually or via cron. This kit also adds a fourth, currently-dormant unit:

4. **dl-run-weekly.js** - weekly-cadence DreamLoops entry point (weekly-curator, artist-spotlight). Both loops are flag-gated OFF (`DREAMLOOPS_ENABLED` + their own per-loop flag) - installing/enabling this timer has no effect until you explicitly turn those flags on in `zol.env`. See `docs/WEEKLY_CURATOR_LOOP.md` and `docs/ARTIST_SPOTLIGHT_LOOP.md` for what each loop does.

This kit provides:
- **systemd service files** for each script
- **systemd timers** for the periodic ones (daily, calendar, weekly loops)
- **migrate.sh** - a guided migration script you run on the Pi
- **README** - this file, documenting what needs review before migration

## Files in This Kit

- `zol-daily.service` + `zol-daily.timer` - hourly curator cast service
- `zol-reply.service` - reply daemon (persistent, restart-on-failure)
- `zol-calendar.service` + `zol-calendar.timer` - 15-minute calendar poller
- `zol-weekly-loops.service` + `zol-weekly-loops.timer` - weekly DreamLoops entry point (Mondays 6am UTC), dormant until flags are set
- `migrate.sh` - the migration script (copy to Pi, read, run as root)
- `README.md` - this file

## Before You Run migrate.sh

You **must** read and review `migrate.sh` and make these edits:

### 1. Verify Placeholder Paths

The script uses these placeholder paths - **edit them to match your Pi setup**:

```bash
REPO_DIR="/home/zaal/zol"              # Where ZOL will live
SYSTEMD_DIR="/etc/systemd/system"      # Standard systemd path (usually OK)
USERNAME="zaal"                        # Pi user who runs ZOL
CREDS_DIR="/home/zaal/.zao/private"    # Where your env files are stored
REPO_URL="https://github.com/bettercallzaal/zol.git"
```

If your setup differs (e.g., you use a different username, or your repo is elsewhere), **edit these at the top of migrate.sh before running**.

### 2. Verify Systemd Unit Defaults

The service files also contain placeholder paths - open each one and verify:

- **WorkingDirectory**: Should point to where the ZOL repo lives (default: `/home/zaal/zol`)
- **EnvironmentFile**: Should point to your credentials file (default: `/home/zaal/.zao/private/zol.env`)
- **User** and **Group**: Should be the user who runs the services (default: `zaal`)
- **HOME** environment variable: Should match your user's home directory (default: `/home/zaal`)

### 3. Prepare Your Credentials File

The systemd units will load environment variables from `~/.zao/private/zol.env`. Ensure this file exists on the Pi and contains:

```bash
# Example ~/.zao/private/zol.env
NEYNAR_API_KEY=your_key_here
BONFIRE_API_KEY=your_key_here
BONFIRE_ID=your_id_here
ZOE_BOT_TOKEN=your_token_here
ZAAL_TELEGRAM_ID=your_id_here
# ... other keys as needed
```

The script checks for this directory and will exit if not found.

### 4. Feature Flags (All OFF by Default)

This kit boots with all feature flags OFF to maintain parity with your current setup:

- `DREAMLOOPS_ENABLED=0` - no DreamLoops automation
- `WEEKLY_CURATOR_ENABLED=0`, `ARTIST_SPOTLIGHT_ENABLED=0` - the two weekly loops stay off even if `DREAMLOOPS_ENABLED` is later turned on; both flags must be set to activate a given loop
- Per-loop feature flags remain OFF

You can enable features later by updating `~/.zao/private/zol.env` on the Pi and reloading systemd:

```bash
# Edit the creds file, then:
sudo systemctl daemon-reload
sudo systemctl restart zol-reply
```

## How to Run the Migration

1. **Copy the files to your Pi**:
   ```bash
   scp -r deploy/ zaal@ansuz:~/zol-migrate/
   ```

2. **SSH to the Pi and review migrate.sh**:
   ```bash
   ssh zaal@ansuz
   # Read through the script carefully:
   cat ~/zol-migrate/migrate.sh
   ```

3. **Edit placeholders** if your paths differ from the defaults.

4. **Run the migration as root**:
   ```bash
   cd ~/zol-migrate
   sudo bash migrate.sh
   ```

The script will:
- Clone/pull the latest ZOL repo
- Run `npm ci` to install dependencies
- Run the full test suite (`npm run check && npm test && npm run dl:validate && npm run dl:test`)
- Copy systemd units to `/etc/systemd/system`
- Enable and start the services

## Verification After Migration

Once the migration completes, verify everything works:

```bash
# Check timer status
systemctl list-timers --all

# View service logs (live)
journalctl -u zol-reply -f
journalctl -u zol-daily -f
journalctl -u zol-calendar -f
journalctl -u zol-weekly-loops -f   # will just log "DREAMLOOPS_ENABLED is off" until you flip the flags

# Manually trigger a service (for testing)
sudo systemctl start zol-daily.service

# Check the dashboard
# (navigate to http://ansuz:8088 from a Tailscale-connected machine)
```

## Rollback (Going Back to Manual/Cron)

If you need to rollback to your previous setup:

1. **Stop the services**:
   ```bash
   sudo systemctl stop zol-daily.timer zol-calendar.timer zol-weekly-loops.timer zol-reply.service
   ```

2. **Disable the services**:
   ```bash
   sudo systemctl disable zol-daily.timer zol-calendar.timer zol-weekly-loops.timer zol-reply.service
   ```

3. **Re-enable your old cron entries** or manually start the scripts as you did before.

## Service Behavior

### zol-daily (hourly curator casts)

- **Timer**: OnBootSec=5min, OnUnitActiveSec=1h
- **First run**: 5 minutes after boot
- **Subsequent runs**: Every hour
- **Type**: oneshot (runs once, exits)
- **Logs**: `journalctl -u zol-daily`

### zol-reply (mention daemon)

- **Type**: simple (long-running)
- **Auto-restart**: Yes, on failure (RestartSec=15s)
- **Startup**: Enabled on boot, will restart if it crashes
- **Logs**: `journalctl -u zol-reply -f`

### zol-calendar (15-minute event poller)

- **Timer**: OnBootSec=30s, OnUnitActiveSec=15min
- **First run**: 30 seconds after boot
- **Subsequent runs**: Every 15 minutes
- **Type**: oneshot (runs once, exits)

### zol-weekly-loops (weekly-curator, artist-spotlight - dormant by default)

- **Timer**: OnCalendar=Mon *-*-* 06:00:00 UTC (matches weekly-curator-v1's declared trigger)
- **Type**: oneshot (runs once, exits)
- **Self-gating**: exits immediately with no side effects unless `DREAMLOOPS_ENABLED=1` AND the loop's own flag (`WEEKLY_CURATOR_ENABLED` / `ARTIST_SPOTLIGHT_ENABLED`) are set in `zol.env` - safe to enable this unit before deciding whether to turn the loops on
- **Output when enabled**: both loops only ever stage a draft into `~/zol/drafts/`, same as `zol-calendar` - nothing auto-posts
- **Logs**: `journalctl -u zol-weekly-loops`
- **Logs**: `journalctl -u zol-calendar`

## Important Notes

- **This kit has never been run against the real Pi.** You are responsible for reviewing it and adapting it to your setup.
- **Always test in a safe environment first** if possible, or run the migration during maintenance window.
- **Backup your current setup** (cron entries, any manual startup scripts) before running migrate.sh.
- **The script uses `set -euo pipefail`** - it will exit immediately on any error. This is intentional for safety.
- **Feature parity**: The migration boots with the same behavior as today - no new features activate just by running this.

## Questions or Issues?

Review the comments in `migrate.sh` and the systemd unit files for detailed explanations. The systemd documentation is also helpful:
- https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
- https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html

Good luck with the migration!
