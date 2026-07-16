#!/bin/bash
# ZOL Pi Migration Script
# This script prepares the Pi to run ZOL's three long-running services via systemd
# instead of cron or manual invocation. It performs the following steps:
#
# 1. Clones or pulls the ZOL repository
# 2. Installs dependencies via npm ci
# 3. Runs the test suite (npm run check, npm test, npm run dl:validate, npm run dl:test)
# 4. Copies systemd unit files into place
# 5. Enables and starts the services with all feature flags OFF (parity with current behavior)
#
# IMPORTANT: This script is meant to be READ and RUN BY YOU (Zaal) on the Pi.
# It has never been tested against the actual Pi and is provided as a template.
# Please review the placeholder paths below and adjust as needed for your setup.
#
# Placeholder paths to review/edit before running:
#   - REPO_DIR: where the ZOL repo will live (currently /home/zaal/zol)
#   - SYSTEMD_DIR: systemd unit file destination (currently /etc/systemd/system)
#   - USERNAME: the user who will run the services (currently zaal)
#   - CREDS_DIR: where creds/env files live (currently /home/zaal/.zao/private)

set -euo pipefail

# Configuration - EDIT THESE FOR YOUR PI SETUP
REPO_DIR="/home/zaal/zol"
SYSTEMD_DIR="/etc/systemd/system"
USERNAME="zaal"
CREDS_DIR="/home/zaal/.zao/private"
REPO_URL="https://github.com/bettercallzaal/zol.git"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check that we're running as root (needed for systemd operations)
if [[ $EUID -ne 0 ]]; then
  log_error "This script must be run as root (use: sudo $0)"
  exit 1
fi

# Check that the credentials directory exists
if [[ ! -d "$CREDS_DIR" ]]; then
  log_error "Credentials directory not found: $CREDS_DIR"
  log_error "Please ensure your .zao/private environment files exist before running this script"
  exit 1
fi

log_info "ZOL Pi Migration Script"
log_info "Repository: $REPO_URL"
log_info "Target directory: $REPO_DIR"
log_info "Systemd units: $SYSTEMD_DIR"
log_info "Running as user: $USERNAME"
log_info ""

# Step 1: Clone or pull the repository
log_info "Step 1: Cloning/pulling repository..."
if [[ -d "$REPO_DIR" ]]; then
  log_info "Repository already exists at $REPO_DIR, pulling latest changes..."
  cd "$REPO_DIR"
  git fetch origin main
  git checkout main
  git reset --hard origin/main
  git clean -fd
else
  log_info "Cloning repository to $REPO_DIR..."
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth=1 "$REPO_URL" "$REPO_DIR"
  cd "$REPO_DIR"
fi

log_info "Repository is now at revision: $(git rev-parse --short HEAD)"
log_info ""

# Step 2: Install dependencies
log_info "Step 2: Installing dependencies (npm ci)..."
npm ci --production
log_info "Dependencies installed successfully"
log_info ""

# Step 3: Run test suite
log_info "Step 3: Running test suite..."
log_info "  - npm run check (syntax validation)"
npm run check

log_info "  - npm test (unit tests)"
npm test

log_info "  - npm run dl:validate (DreamLoops capsule validation)"
npm run dl:validate

log_info "  - npm run dl:test (DreamLoops tests)"
npm run dl:test

log_info "All tests passed"
log_info ""

# Step 4: Copy systemd unit files
log_info "Step 4: Installing systemd units..."
if [[ ! -d "deploy/systemd" ]]; then
  log_error "systemd units not found in deploy/systemd/"
  exit 1
fi

# Copy units
for unit in deploy/systemd/*.service deploy/systemd/*.timer; do
  if [[ -f "$unit" ]]; then
    filename=$(basename "$unit")
    dest="$SYSTEMD_DIR/$filename"
    log_info "  Installing: $filename"
    cp "$unit" "$dest"
    chown root:root "$dest"
    chmod 644 "$dest"
  fi
done

log_info "systemd units copied to $SYSTEMD_DIR"
log_info ""

# Step 5: Reload systemd daemon and enable/start services
log_info "Step 5: Enabling and starting services..."
log_info "  Reloading systemd daemon..."
systemctl daemon-reload

# Enable and start the services
# Note: All feature flags are OFF (DREAMLOOPS_ENABLED=0, etc.) to maintain
# parity with the current manual/cron-based behavior. You can enable features
# later by setting environment variables in the .zao/private/zol.env file.

for service in zol-daily zol-reply zol-calendar; do
  log_info "  Enabling $service..."
  systemctl enable "${service}.service" || systemctl enable "${service}.timer"
done

log_info ""
log_info "  Starting timers..."
systemctl start zol-daily.timer
systemctl start zol-calendar.timer

log_info "  Starting reply daemon..."
systemctl start zol-reply.service

log_info ""
log_info "All services enabled and started"
log_info ""

# Final status
log_info "Step 6: Verifying services..."
echo ""
systemctl status zol-daily.timer || log_warn "zol-daily.timer status check failed"
systemctl status zol-calendar.timer || log_warn "zol-calendar.timer status check failed"
systemctl status zol-reply.service || log_warn "zol-reply.service status check failed"

echo ""
log_info "Migration complete!"
log_info ""
log_info "Next steps:"
log_info "  1. View service logs: journalctl -u zol-reply -f"
log_info "  2. Check timer status: systemctl list-timers --all"
log_info "  3. View drafts via dashboard: http://ansuz:8088 (over Tailscale)"
log_info ""
log_info "To rollback to manual operation:"
log_info "  1. Stop the services: sudo systemctl stop zol-daily.timer zol-calendar.timer zol-reply.service"
log_info "  2. Disable the services: sudo systemctl disable zol-daily.timer zol-calendar.timer zol-reply.service"
log_info "  3. Re-enable your previous cron entries or manual startup scripts"
log_info ""
