#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 0 ]; then
  printf '%s\n' 'ARBITRARY_ARCHIVE_RESTORE_REFUSED: this entry only restores its own freshly generated synthetic archive.' >&2
  exit 1
fi
exec node scripts/disposable-test.mjs npx tsx scripts/synthetic-recovery.ts rehearse
