# Betaspel Singles — MTG Store Platform

> A full-stack inventory, pricing, and sales platform for a Magic: The Gathering card store.
> Built as a data engineering school project, deployed in a real retail environment.

---

## Live Demo

**[prism-card-emporium.lovable.app](https://prism-card-emporium.lovable.app/)**

> **Note:** The frontend is always accessible, but live data (card prices, stock levels, search) requires the backend pipeline to be running on a local machine. If the shop appears empty or search returns no results, the backend is currently offline.

---

## Overview

Most card shops run on generic e-commerce platforms with manual price updates. This system replaces that with an automated data pipeline that syncs prices from two European market sources daily, exposes a fast search API, and provides a customer-facing storefront with features purpose-built for MTG retail.

**Live inventory:** ~43 000 products across ~800 sets
**Price sources:** Cardmarket (EU market leader) + Scryfall
**Pipeline runtime:** ~30 seconds end-to-end

---

## Features

### Customer-facing
- **Card browse** — filter by set, color, type, rarity, CMC, price, foil, language, oracle text
- **AI search** — natural language queries powered by Claude (e.g. *"cheap blue instant under 10kr"*)
- **Decklist checker** — paste or upload any MTGGoldfish decklist; see which cards are in stock, auto-select cheapest versions, split quantities across multiple printings, add directly to cart
- **Trade-in** — customers submit trade-in requests; staff review and import accepted cards directly to inventory

### Staff / Admin
- **Bulk import** — import new stock via Manabox CSV export
- **Price overrides** — set manual EUR or SEK prices per card, bypassing the automated pricing
- **No-price dashboard** — cards in stock with missing market data, with inline price input
- **Match quality report** — flags uncertain card-to-market-data matches for review

---

## Architecture

```
Scryfall API ──┐
Cardmarket  ──►  ingest_bronze.py  →  PostgreSQL: bronze schema
Riksbank FX ──┘                              │
                                             ▼
MySQL (live POS) → ingest_stock.py →  bronze.stock
                                             │
                                      dbt run (~30s)
                                             │
                              ┌──────────────┴──────────────┐
                              ▼                             ▼
                       silver_cards                   silver_stock
                    (prices in SEK,               (parsed references,
                     foil/promo flags,             set matching,
                     USD fallback chain)            condition discounts)
                              └──────────────┬──────────────┘
                                             ▼
                                        gold_cards
                                    (enriched, indexed,
                                     API-ready view)
                                             │
                                      FastAPI (api.py)
                                             │
                                    React frontend (Lovable)
```

### Key design decisions

**Pre-computed tables over live joins** — dbt materializes all transformations into physical tables. The API does simple indexed lookups, not complex CTEs at query time. Result: sub-50ms card search across 100k+ rows.

**Stock delta layer** — between pipeline runs, stock changes (sales, trade-ins) accumulate in `bronze.stock_delta`. The API applies these in-memory so the frontend always shows current stock without a full rebuild.

**Multi-tier card matching** — MySQL references (`MKM-042-F`) are matched to Scryfall card data through 8 fallback strategies: exact set+number → judge promo mapping → set name fuzzy match → collector number cross-reference. Match quality is tracked per row.

**Price fallback chain** — `COALESCE(NULLIF(cardmarket_eur, 0), scryfall_eur, scryfall_usd × fx_rate)` ensures cards with sparse Cardmarket data still get priced via Scryfall.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Data ingestion | Python (requests, mysql-connector) |
| Data warehouse | PostgreSQL 15 |
| Transformations | dbt Core 1.11 |
| Text search | PostgreSQL pg_trgm (GIN indexes) |
| API | FastAPI + psycopg2 |
| Frontend | React + TypeScript (Lovable / shadcn/ui) |
| AI search | Anthropic Claude API (tool-use agentic loop) |
| FX rates | Riksbank open API |
| Price data | Cardmarket S3 bulk export + Scryfall bulk API |

---

## Selected Technical Highlights

### Automated pricing pipeline
Cards are priced using a piecewise linear EUR→SEK markup function with rarity tiers and sell minimums. The same function runs both in dbt (as a PostgreSQL function) and in Python (for manual price input), guaranteeing consistency.

### AI-powered search (`POST /agent/search`)
An agentic loop (up to 6 iterations) uses Claude Haiku with two tools — `find_sets()` and `find_cards()` — to convert natural language into structured filter objects. Returns both filter params and UI chip labels for display.

```
User: "blue instant cheaper than 20kr"
→ { color_identity: "%U%", type_line: "%Instant%", max_price: 20, in_stock: true }
```

### Decklist checker
Parses MTGGoldfish/Arena format decklists, resolves split-card and DFC names, batch-queries all requested cards in a single SQL call, and auto-selects the optimal printing per card (cheapest → best condition → can fill full quantity → most stock). Users can split a 4-of across two different printings and add all to cart in one click.

---

## What I learned

- Designing a **medallion architecture** (bronze/silver/gold) for a real production workload
- Writing **complex dbt models** with multi-CTE matching logic and post-hook index management
- The practical difference between **Cardmarket's sparse data** and Scryfall's comprehensive catalog, and how to build a fallback chain that handles both
- Building a **FastAPI service** that applies in-memory deltas to cached query results
- Integrating the **Anthropic Claude API** with tool use for structured data extraction
- Debugging subtle **psycopg2 quirks** (% escaping, regex dialect differences)

---

## Project status

Active — running in a retail environment. Not open source.
Built 2026 as part of a data engineering program.

---

*Interested in this solution for your store? Get in touch.*

