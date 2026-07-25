#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

if [[ ! -x .venv/bin/uvicorn || ! -d frontend/node_modules ]]; then
  echo "Dependencies are missing. Run ./scripts/setup.sh first."
  exit 1
fi

set -a
source .env
set +a

compose up -d db
echo "Waiting for PostgreSQL..."
until compose exec -T db pg_isready -U "${PG_USER:-postgres}" -d "${PG_DATABASE:-mtg}" >/dev/null 2>&1; do
  sleep 1
done

cleanup() {
  kill "${API_PID:-}" "${WEB_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

.venv/bin/uvicorn backend.api:app --host 127.0.0.1 --port 8000 &
API_PID=$!
npm --prefix frontend run dev -- --host 127.0.0.1 &
WEB_PID=$!

echo
echo "MTG Store is running:"
echo "  Frontend: http://localhost:5173"
echo "  API:      http://localhost:8000"
echo "  API docs: http://localhost:8000/docs"
echo
echo "Press Ctrl+C to stop the app. PostgreSQL remains dormant in Docker."

wait -n "$API_PID" "$WEB_PID"
