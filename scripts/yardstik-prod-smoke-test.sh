#!/usr/bin/env bash
#
# yardstik-prod-smoke-test.sh
#
# Stateless smoke test for the prod backend after the Yardstik cutover.
# Verifies routes are wired correctly WITHOUT creating real Yardstik candidates
# (those cost money in prod and would clutter the dashboard).
#
# Run from anywhere:
#     bash scripts/yardstik-prod-smoke-test.sh
#
# Or against a different host:
#     BASE=https://staging-backend.example.com bash scripts/yardstik-prod-smoke-test.sh
#
# Exits 0 if everything looks right, 1 if any check fails.

set -uo pipefail

BASE="${BASE:-https://api.valetnyc.co}"
PASS=0
FAIL=0

cyan()   { printf '\033[36m%s\033[0m\n' "$1"; }
green()  { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
red()    { printf '\033[31m  ✗ %s\033[0m\n' "$1"; }

# Run a curl + assert exact HTTP status
expect_status() {
    local label="$1"
    local expected="$2"
    local method="$3"
    local url="$4"
    local data="${5:-}"

    local args=(-sS -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" "$url")
    if [[ -n "$data" ]]; then
        args+=(-H 'Content-Type: application/json' -d "$data")
    fi

    local actual
    actual=$(curl "${args[@]}")
    if [[ "$actual" == "$expected" ]]; then
        green "$label (HTTP $actual)"
        PASS=$((PASS + 1))
    else
        red "$label — expected $expected, got $actual"
        FAIL=$((FAIL + 1))
    fi
}

cyan "Yardstik production smoke test against $BASE"
echo

cyan "1. Backend reachable"
expect_status "backend root responds" "404" "GET" "$BASE/"
# (root returns 404 because there's no root handler — that's expected and proves
# the server is up.)

echo
cyan "2. /api/valet/initiateBackgroundCheck route is wired"
# Missing userId → controller should return 400 (NOT 404 — 404 would mean the
# route isn't mounted, which would mean our deploy missed something).
expect_status "missing userId → 400" "400" "POST" \
    "$BASE/api/valet/initiateBackgroundCheck" '{}'

echo
cyan "3. /api/valet/resendBackgroundCheckInvitation route is wired"
expect_status "missing userId → 400" "400" "POST" \
    "$BASE/api/valet/resendBackgroundCheckInvitation" '{}'

echo
cyan "4. /api/valet/backgroundCheckStatus route still works"
expect_status "missing userId → 400" "400" "GET" \
    "$BASE/api/valet/backgroundCheckStatus"

echo
cyan "5. /api/webhooks/yardstik route is wired"
# Empty payload → if WEBHOOK_SIGNATURE_KEY is set, returns 401 (signature fail).
# If not set, returns 200 (no-op since no parseable status).
# Either is fine — both prove the route exists. 404 would mean the route wasn't
# deployed.
result=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
    -H 'Content-Type: application/json' -d '{}' \
    "$BASE/api/webhooks/yardstik")
if [[ "$result" == "401" || "$result" == "200" ]]; then
    green "route exists (HTTP $result — $([[ "$result" == "401" ]] && echo "signed mode" || echo "unsigned mode"))"
    PASS=$((PASS + 1))
else
    red "route missing or broken — expected 200 or 401, got $result"
    FAIL=$((FAIL + 1))
fi

echo
cyan "6. /api/webhooks/certn route still wired (legacy)"
expect_status "empty payload acked" "200" "POST" \
    "$BASE/api/webhooks/certn" '{}'

echo
echo "─────────────────────────────────────────"
echo "PASSED: $PASS    FAILED: $FAIL"
echo "─────────────────────────────────────────"

if [[ $FAIL -gt 0 ]]; then
    echo
    echo "⚠️  Smoke test FAILED. Likely causes:"
    echo "  - 404 on any /api/valet/... → controller code didn't deploy"
    echo "  - 404 on /api/webhooks/yardstik → routes/webhook.js didn't deploy"
    echo "  - 5xx → backend crashed on startup; check pm2 logs"
    exit 1
fi

echo
echo "✓ All routes wired. To verify the full Yardstik flow end-to-end:"
echo "  1. Sign up a new valet via the iOS app (or call /initiate manually)"
echo "  2. Complete the Yardstik form using a real personal email"
echo "  3. Watch the webhook fire and the valet transition to active"
echo "  4. Delete the test valet from MongoDB when done"
exit 0
