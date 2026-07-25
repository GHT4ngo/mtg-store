# Betaspel Singles — MTG Store proof of concept

A completed proof of concept for a Magic: The Gathering store: data ingestion,
warehouse transformations, a FastAPI service, and a React storefront.

> **Status: dormant and preserved.** The concept was successfully implemented, but it is
> not under active development or operated as a public service. The repository is kept
> launch-ready for demonstrations and future reuse.

## What it demonstrates

- A bronze/silver/gold data pipeline using PostgreSQL and dbt
- Card and price ingestion from public sources
- Optional inventory and order ingestion from a shop's MySQL/POS database
- Indexed card search through FastAPI
- A React/TypeScript storefront with filters, decklist search, trade-in flows, and
  administration screens
- Optional natural-language search using Anthropic

No production credentials, customer data, downloaded card datasets, database volumes, or
generated build files are included.

## Linux quick start

Requirements:

- Linux
- Docker with Docker Compose v2
- Python 3.11 or newer
- Node.js 20 or newer with npm

```bash
git clone https://github.com/GHT4ngo/MTG-Store-Proof-of-Concept.git
cd MTG-Store-Proof-of-Concept

./scripts/setup.sh
./scripts/start.sh
```

Open:

- Storefront: <http://localhost:5173>
- API status: <http://localhost:8000>
- Interactive API documentation: <http://localhost:8000/docs>

The first setup creates a local `.env`, Python virtual environment, frontend dependencies,
and dbt packages. The first launch starts a Dockerized PostgreSQL database. If your Linux
user cannot access Docker directly, the launcher asks for `sudo` once. The database remains
available between launches; stopping the app does not delete it.

## Load card data

The application starts without downloading the large source datasets. To populate the
catalog from Cardmarket, Scryfall, and Riksbank:

```bash
./scripts/refresh-data.sh
```

This download can be large and may take several minutes. Downloaded files are cached in
`data/`, which is intentionally excluded from Git.

The original shop inventory and sales analytics depend on a separate MySQL/POS system.
Add its connection details to `.env` only if you have a compatible database. Without those
credentials, the public catalog and pricing pipeline still run, while store-specific stock
and order ingestion are skipped.

## Configuration

Copy `.env.example` manually if needed:

```bash
cp .env.example .env
```

Important variables:

- `PG_*`: local PostgreSQL connection used by the API and dbt
- `MYSQL_*`: optional private shop/POS connection
- `ANTHROPIC_API_KEY`: optional natural-language search
- `DATA_DIR`: local download cache
- `VITE_API_URL`: frontend API address, configured in `frontend/.env`

Never commit `.env` files.

## Repository structure

```text
backend/          FastAPI service and ingestion scripts
database/init/    Local PostgreSQL bootstrap schema
dbt/              Silver and gold warehouse transformations
frontend/         React, TypeScript, Vite, and shadcn/ui
scripts/          Linux setup, launch, and refresh commands
docker-compose.yml
requirements.txt
```

## Architecture

```text
Cardmarket ─┐
Scryfall  ──┼─> Python ingestion ─> PostgreSQL bronze
Riksbank  ──┘                            │
                                         v
Optional shop MySQL ───────────────> dbt silver/gold
                                         │
                                         v
                                  FastAPI <─> React
```

## Useful commands

```bash
# Start the local application
./scripts/start.sh

# Refresh data and rebuild the warehouse
./scripts/refresh-data.sh

# Stop PostgreSQL as well
docker compose down

# Remove the local database volume (destructive)
docker compose down -v

# Backend syntax check
python3 -m compileall -q backend

# Frontend checks
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
```

## Notes

- The public setup is intentionally Linux-first and does not include the original Windows
  batch files, executables, logs, cached datasets, virtual environments, or obsolete source
  copies.
- Store-mutating admin features require the compatible private MySQL/POS database.
- This is a portfolio-quality proof of concept, not a supported production commerce system.
