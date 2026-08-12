#!/usr/bin/env bash
#
# build12-deploy.sh
#
# Build 12 backend deploy. Pushes only the files actually changed for
# this build, leaving server.js alone (Build 11 mounts in local server.js
# still aren't ready for prod). Auto-snapshots and aborts on any failure.

set -euo pipefail

KEY="${KEY:-/Users/rishiganesh/Desktop/Valet Network Inc. Code/valetnyc-production-newyork.pem}"
HOST="${HOST:-ubuntu@18.212.79.178}"
DEST="${DEST:-/var/www/html/valetnyc-backend}"
LOCAL_REPO="${LOCAL_REPO:-/Users/rishiganesh/Desktop/Valet Network Inc. Code/ValetNYC-Backend-NodeJS}"

cyan()  { printf '\033[36m%s\033[0m\n' "$1"; }
green() { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
red()   { printf '\033[31m  ✗ %s\033[0m\n' "$1" 1>&2; }

cd "$LOCAL_REPO"

cyan "Step A: snapshotting"
ssh -i "$KEY" "$HOST" "
  set -e
  TS=\$(date +%Y%m%d-%H%M%S)
  BACKUP=/home/ubuntu/backups/build12-\$TS
  mkdir -p \$BACKUP
  cp -r $DEST/services $DEST/controllers $DEST/models \$BACKUP/
  echo \"backup: \$BACKUP\"
"
green "snapshot complete"

cyan "Step B: pushing changed files"
scp_one() {
    local src="$1"
    local dst="$2"
    if scp -i "$KEY" -q "$src" "$HOST:$dst"; then
        green "$src → $dst"
    else
        red "$src → $dst FAILED"
        exit 1
    fi
}
scp_one services/backgroundCheck/yardstikProvider.js  "$DEST/services/backgroundCheck/"
scp_one services/valetStatusService.js                "$DEST/services/"
scp_one controllers/backgroundCheckController.js      "$DEST/controllers/"
scp_one controllers/adminController.js                "$DEST/controllers/"
scp_one models/User.js                                "$DEST/models/"

cyan "Step C: PM2 restart"
ssh -i "$KEY" "$HOST" "pm2 restart valetnyc-production --update-env"
sleep 4
ssh -i "$KEY" "$HOST" "pm2 status valetnyc-production | tail -5"

cyan "Step D: health check"
HEALTH=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.valetnyc.co/ || echo "000")
if [[ "$HEALTH" =~ ^[45][0-9][0-9]$ && "$HEALTH" != "404" && "$HEALTH" != "401" && "$HEALTH" != "400" ]]; then
    red "backend HTTP $HEALTH — investigate"
    exit 1
fi
if [[ "$HEALTH" == "000" ]]; then
    red "no response from backend — investigate"
    exit 1
fi
green "backend responding (HTTP $HEALTH)"

cyan "Step E: smoke test"
bash "$LOCAL_REPO/scripts/yardstik-prod-smoke-test.sh"
