#!/usr/bin/env bash
set -euo pipefail
dump_path="${1:?usage: npm run restore:verify -- /absolute/path/to/backup.dump}"
test_db="cisme_restore_verify"
docker compose -f infra/compose.yaml exec -T postgres dropdb -U cisme --if-exists "$test_db"
docker compose -f infra/compose.yaml exec -T postgres createdb -U cisme "$test_db"
docker compose -f infra/compose.yaml exec -T postgres pg_restore -U cisme -d "$test_db" --clean --if-exists < "$dump_path"
docker compose -f infra/compose.yaml exec -T postgres psql -U cisme -d "$test_db" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS migration_count FROM schema_migration"
docker compose -f infra/compose.yaml exec -T postgres dropdb -U cisme "$test_db"
echo "restore verified and disposable database removed"
