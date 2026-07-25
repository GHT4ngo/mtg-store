#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

set -a
source .env
set +a

compose up -d db

.venv/bin/python backend/ingest_bronze.py

if [[ -n "${MYSQL_DATABASE:-}" && -n "${MYSQL_USER:-}" ]]; then
  .venv/bin/python backend/ingest_stock.py
  .venv/bin/python backend/ingest_orders.py
else
  echo "MySQL/POS credentials are not configured; shop stock and order ingestion were skipped."
fi

.venv/bin/python backend/setup_pricing_tables.py
.venv/bin/dbt build --project-dir dbt --profiles-dir dbt

echo "Data refresh complete."
