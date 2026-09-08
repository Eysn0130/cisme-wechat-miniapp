#!/usr/bin/env bash
set -euo pipefail
backup_dir="${CISME_BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose -f infra/compose.yaml exec -T postgres pg_dump -U cisme -Fc cisme > "$backup_dir/cisme-$stamp.dump"
echo "backup written: $backup_dir/cisme-$stamp.dump"
