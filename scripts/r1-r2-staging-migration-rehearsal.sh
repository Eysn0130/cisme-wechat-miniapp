#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
root="$(cd "$(dirname "$0")" && pwd)"
migration_dir="${MIGRATION_DIR:-$root/../db/migrations}"
expected_database_name="${EXPECTED_DATABASE_NAME:-cisme_staging}"
m030="202609110003_role_aware_authority.sql"
m031="202609110004_support_foundation.sql"

psql_safe() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
scalar() { psql_safe -qAtc "$1"; }
assert_eq() { [[ "$1" == "$2" ]] || { echo "ASSERTION_FAILED expected=$2 actual=$1" >&2; exit 70; }; }
assert_true() { assert_eq "$(scalar "$1")" "t"; }
assert_scalar_eq() { local expected="$1" sql="$2"; assert_eq "$(scalar "$sql")" "$expected"; }

apply_migration() {
  local version="$1" path="$2" scratch
  scratch="$(mktemp)"
  sed '/^-- migrate:down$/,$d' "$path" > "$scratch"
  { echo 'BEGIN;'; cat "$scratch"; printf "INSERT INTO schema_migration(version) VALUES ('%s');\n" "$version"; echo 'COMMIT;'; } | psql_safe >/dev/null
  rm -f "$scratch"
}

rollback_migration() {
  local version="$1" path="$2" scratch
  scratch="$(mktemp)"
  sed '1,/^-- migrate:down$/d' "$path" > "$scratch"
  { echo 'BEGIN;'; cat "$scratch"; printf "DELETE FROM schema_migration WHERE version='%s';\n" "$version"; echo 'COMMIT;'; } | psql_safe >/dev/null
  rm -f "$scratch"
}

table_fingerprint() {
  scalar "SELECT md5(string_agg(table_name,E'\\n' ORDER BY table_name)) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
}

ledger_fingerprint() {
  scalar "SELECT md5(string_agg(version,E'\\n' ORDER BY version)) FROM schema_migration"
}

verify_integrity() {
  assert_scalar_eq "0" "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid"
  assert_scalar_eq "0" "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated"
  assert_scalar_eq "0" "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f' AND (c.conrelid=0 OR c.confrelid=0)"
  assert_scalar_eq "9" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('data_retention_policy','processing_purpose','processor_registry','consent_receipt','legal_hold','legal_hold_binding','data_export_job','data_erasure_job','privacy_request_event')"
  assert_scalar_eq "8" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ugc_post','ugc_post_revision','ugc_media_asset','ugc_post_media','ugc_comment','ugc_report','moderation_case','moderation_action')"
  assert_scalar_eq "false" "SELECT enabled::text FROM emergency_switch WHERE key='uploads'"
  assert_scalar_eq "false" "SELECT enabled::text FROM emergency_switch WHERE key='community'"
}

verify_030() {
  assert_scalar_eq "30" "SELECT count(*) FROM schema_migration"
  assert_true "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='authority_grant')"
  assert_scalar_eq "0" "SELECT count(*) FROM authority_grant"
  verify_integrity
}

verify_031() {
  assert_scalar_eq "31" "SELECT count(*) FROM schema_migration"
  assert_scalar_eq "3" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('authority_grant','support_conversation','support_message')"
  assert_scalar_eq "2" "SELECT count(*) FROM data_retention_policy WHERE code IN ('support_conversation_policy_pending','support_audit_policy_pending') AND duration_days IS NULL AND active=false AND enforcement_state='declared'"
  assert_scalar_eq "1" "SELECT count(*) FROM processing_purpose WHERE code='support_service' AND active=false"
  assert_scalar_eq "0" "SELECT count(*) FROM authority_grant"
  assert_scalar_eq "0" "SELECT count(*) FROM support_conversation"
  assert_scalar_eq "0" "SELECT count(*) FROM support_message"
  verify_integrity
}

assert_scalar_eq "$expected_database_name" "SELECT current_database()"
assert_scalar_eq "29" "SELECT count(*) FROM schema_migration"
assert_scalar_eq "66" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
if scalar "SELECT count(*) FROM authority_grant" >/dev/null 2>&1; then
  echo "ASSERTION_FAILED authority_grant unexpectedly exists at migration 29" >&2
  exit 70
fi
verify_integrity
baseline_tables="$(table_fingerprint)"
baseline_ledger="$(ledger_fingerprint)"
baseline_indexes="$(scalar "SELECT count(*) FROM pg_indexes WHERE schemaname='public'")"
baseline_constraints="$(scalar "SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='public'")"

apply_migration "$m030" "$migration_dir/$m030"
verify_030
apply_migration "$m031" "$migration_dir/$m031"
verify_031

rollback_migration "$m031" "$migration_dir/$m031"
verify_030
assert_scalar_eq "0" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'support_%'"

rollback_migration "$m030" "$migration_dir/$m030"
assert_scalar_eq "29" "SELECT count(*) FROM schema_migration"
assert_scalar_eq "66" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
assert_eq "$(table_fingerprint)" "$baseline_tables"
assert_eq "$(ledger_fingerprint)" "$baseline_ledger"
assert_eq "$(scalar "SELECT count(*) FROM pg_indexes WHERE schemaname='public'")" "$baseline_indexes"
assert_eq "$(scalar "SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='public'")" "$baseline_constraints"
assert_scalar_eq "0" "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE '%support%' OR p.proname LIKE '%authority_grant%')"
verify_integrity

apply_migration "$m030" "$migration_dir/$m030"
apply_migration "$m031" "$migration_dir/$m031"
verify_031
assert_scalar_eq "69" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"

printf 'R1_R2_STAGING_MIGRATION_REHEARSAL_VERIFIED baseline=29/66 final=31/69 baseline_table_sha=%s baseline_ledger_sha=%s final_indexes=%s final_constraints=%s\n' \
  "$baseline_tables" "$baseline_ledger" "$(scalar "SELECT count(*) FROM pg_indexes WHERE schemaname='public'")" "$(scalar "SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='public'")"
