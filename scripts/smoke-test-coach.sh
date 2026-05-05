#!/usr/bin/env bash
#
# Smoke test for v1.10.x composite endpoints + people layer.
# Usage:
#   API_KEY=<your-key> ./scripts/smoke-test-coach.sh
# Or:
#   API_KEY=<your-key> API_BASE=https://ab-brain.up.railway.app ./scripts/smoke-test-coach.sh
#
# Exits 0 if all checks pass, 1 if any fail. Prints PASS/FAIL per endpoint
# and a one-line summary at the end.

set -e

: "${API_KEY:?API_KEY env var required}"
: "${API_BASE:=https://ab-brain.up.railway.app}"

PASS=0
FAIL=0
FAIL_LIST=()

check() {
  local name="$1"
  local url="$2"
  local must_have="$3"  # space-separated list of JSON keys that must appear

  local body status
  body=$(curl -s -o /tmp/smoke.json -w "%{http_code}" -H "x-api-key: $API_KEY" "$url") || {
    echo "FAIL  $name  (curl error)"; FAIL=$((FAIL+1)); FAIL_LIST+=("$name"); return
  }
  status="$body"

  if [ "$status" != "200" ]; then
    echo "FAIL  $name  (HTTP $status)"
    FAIL=$((FAIL+1)); FAIL_LIST+=("$name")
    return
  fi

  for key in $must_have; do
    if ! grep -q "\"$key\"" /tmp/smoke.json; then
      echo "FAIL  $name  (missing key: $key)"
      FAIL=$((FAIL+1)); FAIL_LIST+=("$name:$key")
      return
    fi
  done

  echo "PASS  $name"
  PASS=$((PASS+1))
}

echo "=== Smoke test against $API_BASE ==="
echo ""

# Phase 1 fixes — endpoints that used to 500
check "GET /api/transcripts/speakers (Phase 1)" \
      "$API_BASE/api/transcripts/speakers?limit=5" \
      "speakers"

check "GET /api/health/insights/trends (Phase 1 — used to 500 with ReferenceError)" \
      "$API_BASE/api/health/insights/trends" \
      "training"

# Phase 3 — composite endpoints
check "GET /api/coach/morning (Phase 3)" \
      "$API_BASE/api/coach/morning" \
      "today_plan readiness alerts active_injuries yesterday_summary recent_coaching"

check "GET /api/coach/midday-amend (Phase 3)" \
      "$API_BASE/api/coach/midday-amend" \
      "today_plan readiness alerts active_injuries today_session"

check "GET /api/coach/preworkout?in_minutes=90 (Phase 3)" \
      "$API_BASE/api/coach/preworkout?in_minutes=90" \
      "today_plan latest_body today_macros last_fueling_rehearsal"

check "GET /api/coach/postworkout (Phase 3)" \
      "$API_BASE/api/coach/postworkout" \
      "latest_workout macros hydration today_context"

check "GET /api/coach/end-of-day (Phase 3)" \
      "$API_BASE/api/coach/end-of-day" \
      "today_plan today_workouts nutrition_summary subjective_context effort_total"

check "GET /api/coach/weekly (Phase 3)" \
      "$API_BASE/api/coach/weekly" \
      "training nutrition targets upcoming_race current_block"

# Phase 4 — people layer
check "GET /api/people (Phase 4)" \
      "$API_BASE/api/people?limit=5" \
      "people"

# v2 vitals (Phase 0/1/2 chain — make sure earlier work still works)
check "GET /api/v2/daily-vitals (still works)" \
      "$API_BASE/api/v2/daily-vitals?limit=3" \
      "rows"

# Health check (sanity)
check "GET /api/health-check (sanity)" \
      "$API_BASE/api/health-check" \
      "version"

echo ""
echo "=== Summary ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Failed endpoints:"
  for f in "${FAIL_LIST[@]}"; do echo "  - $f"; done
  exit 1
fi

# Bonus: check version is actually v1.10.x (deploy verification)
version=$(grep -oE '"version":"[^"]+"' /tmp/smoke.json | sed 's/"version":"//;s/"//')
echo ""
echo "Deployed version: $version"
case "$version" in
  1.10.*) echo "OK — deploy is on v1.10.x branch" ;;
  *) echo "WARN — deploy is on $version, expected 1.10.x. Branch may not be merged to deploy target." ;;
esac
