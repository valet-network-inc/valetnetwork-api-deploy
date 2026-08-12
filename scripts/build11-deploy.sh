#!/usr/bin/env bash
#
# build11-deploy.sh
#
# Ships the Build 11 backend code that was deliberately excluded from the
# Yardstik cutover (2026-05-18). Adds:
#   - 7 new files (extension, parking-note, saved-customer)
#   - 5 modified files (order/orderPhoto controllers, Order model,
#     routes/order, server.js with /api/parking-notes + /api/saved-customers
#     mounts)
#
# Snapshots existing prod, scps all 12 files, restarts PM2, smoke-tests
# the new routes. Aborts on any failure.

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
  BACKUP=/home/ubuntu/backups/build11-\$TS
  mkdir -p \$BACKUP
  cp -r $DEST/services $DEST/controllers $DEST/models $DEST/routes $DEST/server.js \$BACKUP/
  echo \"backup: \$BACKUP\"
"
green "snapshot complete"

cyan "Step B: pushing new files"
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
# New
scp_one controllers/extensionController.js     "$DEST/controllers/"
scp_one controllers/parkingNoteController.js   "$DEST/controllers/"
scp_one controllers/savedCustomerController.js "$DEST/controllers/"
scp_one models/ParkingNote.js                  "$DEST/models/"
scp_one models/SavedCustomer.js                "$DEST/models/"
scp_one routes/parkingNote.js                  "$DEST/routes/"
scp_one routes/savedCustomer.js                "$DEST/routes/"
# Modified
scp_one controllers/orderController.js         "$DEST/controllers/"
scp_one controllers/orderPhotoController.js    "$DEST/controllers/"
scp_one models/Order.js                        "$DEST/models/"
scp_one routes/order.js                        "$DEST/routes/"
scp_one server.js                              "$DEST/"

cyan "Step C: PM2 restart"
ssh -i "$KEY" "$HOST" "pm2 restart valetnyc-production --update-env"
sleep 4
ssh -i "$KEY" "$HOST" "pm2 status valetnyc-production | tail -5"

cyan "Step D: health check"
HEALTH=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.valetnyc.co/ || echo "000")
if [[ "$HEALTH" == "000" ]]; then
    red "no response from backend"
    exit 1
fi
if [[ "$HEALTH" =~ ^5 ]]; then
    red "backend 5xx (HTTP $HEALTH) — investigate"
    exit 1
fi
green "backend responding (HTTP $HEALTH)"

cyan "Step E: Build 11 route smoke check"
NEAR=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  "https://api.valetnyc.co/api/parking-notes/near?lat=40.75&lng=-73.99&radiusMeters=30")
SAVED=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  "https://api.valetnyc.co/api/saved-customers?enterpriseId=test")
if [[ "$NEAR" == "200" || "$NEAR" == "401" || "$NEAR" == "400" ]]; then
    green "/api/parking-notes/near → HTTP $NEAR (route wired)"
else
    red "/api/parking-notes/near → HTTP $NEAR (route NOT wired)"
    exit 1
fi
if [[ "$SAVED" == "200" || "$SAVED" == "401" || "$SAVED" == "400" ]]; then
    green "/api/saved-customers → HTTP $SAVED (route wired)"
else
    red "/api/saved-customers → HTTP $SAVED (route NOT wired)"
    exit 1
fi

cyan "Step F: Yardstik smoke (regression)"
bash "$LOCAL_REPO/scripts/yardstik-prod-smoke-test.sh"
