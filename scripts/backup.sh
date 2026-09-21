#!/usr/bin/env bash
set -euo pipefail
# The old implicit compose/cisme target is intentionally no longer callable.
# Production encrypted maintenance is a separately approved deployment action.
printf '%s\n' 'EXPLICIT_APPROVED_BACKUP_TARGET_REQUIRED: use the owned synthetic recovery rehearsal for local verification.' >&2
exit 1
