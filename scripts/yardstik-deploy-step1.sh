#!/usr/bin/env bash
#
# yardstik-deploy-step1.sh
#
# Phase 4 Step 1: Snapshot existing prod backend → scp all new/modified files →
# restart PM2 → verify health. This is the "deploy code, no behavior change"
# step — the env still says BACKGROUND_CHECK_PROVIDER=certn (or unset), so user-
# facing behavior is unchanged.
#
# Aborts on any scp/ssh failure. Safe to re-run (each invocation creates a fresh
# timestamped backup).
#
# Usage from local machine, run from anywhere:
#     bash scripts/yardstik-deploy-step1.sh
#
# Override defaults via env vars if needed:
#     KEY=... HOST=... DEST=... bash scripts/yardstik-deploy-step1.sh

set -euo pipefail

KEY="${KEY:-/Users/rishiganesh/Desktop/Valet Network Inc. Code/valetnyc-production-newyork.pem}"
HOST="${HOST:-ubuntu@18.212.79.178}"
DEST="${DEST:-/var/www/html/valetnyc-backend}"
LOCAL_REPO="${LOCAL_REPO:-/Users/rishiganesh/Desktop/Valet Network Inc. Code/ValetNYC-Backend-NodeJS}"

cyan()  { printf '\033[36m%s\033[0m\n' "$1"; }
green() { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
red()   { printf '\033[31m  ✗ %s\033[0m\n' "$1" 1>&2; }

cd "$LOCAL_REPO"

cyan "Step 1a: snapshotting existing prod backend"
ssh -i "$KEY" "$HOST" "
  set -e
  TS=\$(date +%Y%m%d-%H%M%S)
  BACKUP=/home/ubuntu/backups/yardstik-cutover-\$TS
  mkdir -p \$BACKUP
  cp -r $DEST/services $DEST/controllers $DEST/models $DEST/routes $DEST/server.js $DEST/scripts \$BACKUP/
  echo \"backup: \$BACKUP\"
"
green "snapshot complete"

cyan "Step 1b: pushing new + modified files"
ssh -i "$KEY" "$HOST" "mkdir -p $DEST/services/backgroundCheck"

scp_one() {
    local src="$1"
    local dst="$2"
    if scp -i "$KEY" -q "$src" "$HOST:$dst"; then
        green "$src → $dst"
    else
        red "failed to scp $src"
        exit 1
    fi
}

scp_one services/backgroundCheck/index.js            "$DEST/services/backgroundCheck/"
scp_one services/backgroundCheck/certnProvider.js     "$DEST/services/backgroundCheck/"
scp_one services/backgroundCheck/yardstikProvider.js  "$DEST/services/backgroundCheck/"
scp_one controllers/backgroundCheckController.js     "$DEST/controllers/"
scp_one models/User.js                                "$DEST/models/"
scp_one routes/webhook.js                             "$DEST/routes/"
scp_one routes/valet.js                               "$DEST/routes/"
scp_one server.js                                     "$DEST/"
scp_one scripts/grandfatherExistingValetsForYardstik.js "$DEST/scripts/"
scp_one scripts/yardstik-prod-smoke-test.sh             "$DEST/scripts/"

cyan "Step 1c: restarting PM2 (with --update-env)"
ssh -i "$KEY" "$HOST" "
  set -e
  pm2 restart valetnyc-production --update-env
  sleep 3
  pm2 status valetnyc-production
"
green "PM2 restart complete"

echo
cyan "Verification:"
HTTP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.valetnyc.co/)
# Acceptable: any 2xx/3xx/4xx (404 expected since there's no root route).
# Unacceptable: 5xx (server error) or 000 (no response — backend down).
if [[ "$HTTP_STATUS" =~ ^[234][0-9][0-9]$ ]]; then
    green "backend responding (HTTP $HTTP_STATUS)"
else
    red "backend HTTP $HTTP_STATUS — server likely down or 5xx-ing"
    exit 1
fi

echo
cyan "Running smoke test against prod"
bash "$LOCAL_REPO/scripts/yardstik-prod-smoke-test.sh" || {
    red "smoke test FAILED — investigate before proceeding to Step 2"
    exit 1
}

echo
cyan "✅ Step 1 complete. Next:"
echo "  Step 2: ssh -i \"\$KEY\" \"$HOST\" \"cd $DEST && DRY_RUN=1 node scripts/grandfatherExistingValetsForYardstik.js\""
