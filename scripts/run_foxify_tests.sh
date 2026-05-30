#!/bin/bash
# Foxify v2 platform — unit test pass/fail summary
#
# Runs every test in the two-sided/foxify-v2 test suite and gives a
# single-screen result so operator can quickly verify platform health
# before any deploy or operational change.
#
# Usage:
#   bash scripts/run_foxify_tests.sh
#
# Exit codes:
#   0 = all passing
#   1 = one or more failures (see report for details)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/services/api"

LOG=$(mktemp -t foxify_tests.XXXXXX.log)
trap "rm -f $LOG" EXIT

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  FOXIFY V2 PLATFORM — UNIT TEST SUITE"
echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "  Running all tests matching 'twoSided' filter ..."
echo ""

TEST_FILTER=twoSided node scripts/run-tests.mjs > "$LOG" 2>&1

PASS=$(grep -E "^# pass [0-9]+" "$LOG" | grep -oE "[0-9]+" | tail -1)
FAIL=$(grep -E "^# fail [0-9]+" "$LOG" | grep -oE "[0-9]+" | tail -1)
DUR=$(grep -E "^# duration_ms [0-9]+" "$LOG" | grep -oE "[0-9]+" | tail -1)
PASS=${PASS:-0}
FAIL=${FAIL:-0}
DUR=${DUR:-0}
TOTAL=$((PASS + FAIL))

if [ "$TOTAL" -gt "0" ]; then
  PCT=$(python3 -c "print(f'{$PASS / ($PASS + $FAIL) * 100:.1f}')" 2>/dev/null)
else
  PCT="0.0"
fi
DUR_SEC=$((DUR / 1000))

echo ""
echo "────────────────────────────────────────────────────────────────────────"
echo "  RESULTS"
echo "────────────────────────────────────────────────────────────────────────"
printf "  Total tests:     %d\n" "$TOTAL"
printf "  Passing:         %d\n" "$PASS"
printf "  Failing:         %d\n" "$FAIL"
printf "  Duration:        %ds\n" "$DUR_SEC"
printf "  Pass rate:       %s%%\n" "$PCT"

if [ "$FAIL" -gt "0" ]; then
  echo ""
  echo "  Failing tests (one line each):"
  grep "^not ok " "$LOG" | head -20 | sed 's/^/    /'
fi

echo ""
echo "════════════════════════════════════════════════════════════════════════"
if [ "$FAIL" = "0" ]; then
  echo "  RESULT:  ✅  ALL TESTS PASSING — platform is green"
else
  echo "  RESULT:  🟡  ${FAIL} test(s) failing — investigate above"
fi
echo "════════════════════════════════════════════════════════════════════════"
echo ""

# Exit code: 0 if all pass, 1 if any fail
if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
