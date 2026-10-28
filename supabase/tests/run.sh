#!/usr/bin/env bash
# Apply every migration to a scratch database and run the schema smoke test.
# Needs a running Postgres; set PGHOST/PGPORT/PGUSER as usual.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${MR_TEST_DB:-mr_test}
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/auth_stub.sql
for f in migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"; done
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/schema_smoke.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/app_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/improve_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/projects_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/work_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/alerts_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/audit_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/approvals_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/inspections_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/analyses_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/views_api.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/components_api.sql
