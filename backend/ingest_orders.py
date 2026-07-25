"""
ingest_orders.py  —  MySQL order_order + order_orderitem -> bronze.order_items
Incremental: only fetches rows with created_at > max already in postgres.
All singles ("löskort" in name). game='MTG' for Magic, 'Other' for everything else.
"""

import mysql.connector
import psycopg2
import psycopg2.extras
import os
from datetime import datetime
from dotenv import load_dotenv
load_dotenv()

GREEN  = "\033[32m"
CYAN   = "\033[36m"
YELLOW = "\033[33m"
RED    = "\033[31m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def print_section(title):
    print()
    print(CYAN + "-" * 60 + RESET)
    print(CYAN + BOLD + f"  {title}" + RESET)
    print(CYAN + "-" * 60 + RESET)

def print_ok(msg):   print(f"  {GREEN}OK{RESET}  {msg}")
def print_info(msg): print(f"  {CYAN}>>{RESET}  {msg}")
def print_warn(msg): print(f"  {YELLOW}!{RESET}   {msg}")

# --- DB connections ------------------------------------------------------------

def get_mysql():
    return mysql.connector.connect(
        host=os.environ["MYSQL_HOST"],
        port=int(os.environ.get("MYSQL_PORT", 3306)),
        user=os.environ["MYSQL_USER"],
        password=os.environ["MYSQL_PASSWORD"],
        database=os.environ["MYSQL_DATABASE"],
        charset="utf8mb4",
    )

def get_pg():
    return psycopg2.connect(
        host=os.environ["PG_HOST"],
        port=os.environ["PG_PORT"],
        dbname=os.environ["PG_DATABASE"],
        user=os.environ["PG_USER"],
        password=os.environ["PG_PASSWORD"],
    )

# --- Ensure bronze table exists -----------------------------------------------

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS bronze.order_items (
    id                  BIGINT PRIMARY KEY,
    order_id            INT,
    product_id          INT,
    sku                 VARCHAR(128),
    name                VARCHAR(256),
    quantity            INT,
    price_wot           NUMERIC(12,2),   -- sale price ex VAT (SEK)
    wholesale_price     NUMERIC(12,2),   -- cost price (SEK)
    order_status        VARCHAR(100),
    is_instore          BOOLEAN,
    carrier_name        VARCHAR(128),
    order_created_at    TIMESTAMP,
    item_created_at     TIMESTAMP,
    game                VARCHAR(50)  DEFAULT 'MTG',
    ingested_at         TIMESTAMP DEFAULT NOW()
)
"""

# Run separately so indexes are only created after the game column exists
CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS order_items_order_date ON bronze.order_items (order_created_at)",
    "CREATE INDEX IF NOT EXISTS order_items_sku        ON bronze.order_items (sku)",
    "CREATE INDEX IF NOT EXISTS order_items_status     ON bronze.order_items (order_status)",
    "CREATE INDEX IF NOT EXISTS order_items_game       ON bronze.order_items (game)",
]

MIGRATE_GAME_COL = """
ALTER TABLE bronze.order_items
    ADD COLUMN IF NOT EXISTS game VARCHAR(50) DEFAULT 'MTG'
"""

# --- Main ---------------------------------------------------------------------

def main(backfill_other: bool = False):
    print_section("Order Ingestion -- MySQL -> bronze.order_items")

    pg = get_pg()
    with pg.cursor() as cur:
        cur.execute(CREATE_TABLE)
        cur.execute(MIGRATE_GAME_COL)
        for idx_sql in CREATE_INDEXES:
            cur.execute(idx_sql)
        pg.commit()

        if backfill_other:
            # One-time backfill: fetch all non-MTG löskort items (never ingested before)
            last_ingested = datetime(2000, 1, 1)
            name_filter   = "LIKE '%%löskort%%' AND oi.name NOT LIKE 'Magic löskort%%'"
            print_info("BACKFILL MODE: fetching all non-MTG löskort singles from history")
        elif getattr(main, '_backfill_mtg_bulk', False):
            # One-time backfill: fetch all historical "MTG:" bulk products
            last_ingested = datetime(2000, 1, 1)
            name_filter   = "LIKE 'MTG:%'"
            print_info("BACKFILL MODE: fetching all MTG: bulk items from history")
        else:
            # Normal incremental: löskort + MTG: bulk items since last watermark
            cur.execute("SELECT MAX(item_created_at) FROM bronze.order_items")
            row = cur.fetchone()
            last_ingested = row[0] if row and row[0] else datetime(2000, 1, 1)
            name_filter   = "LIKE '%%löskort%%' OR oi.name LIKE '%%MTG:%%'"

    print_info(f"Fetching rows after {last_ingested}")

    mysql_conn = get_mysql()
    mysql_cur = mysql_conn.cursor(dictionary=True)

    # Broad filter: all löskort (MTG + other card games)
    mysql_cur.execute(f"""
        SELECT
            oi.id,
            oi.order_id,
            oi.product_id,
            oi.sku,
            oi.name,
            oi.quantity,
            oi.price_wot,
            oi.wholesale_price,
            o.order_status,
            o.carrier_name,
            o.is_instore,
            o.created_at  AS order_created_at,
            oi.created_at AS item_created_at
        FROM order_orderitem oi
        JOIN order_order o ON o.id = oi.order_id
        WHERE oi.name {name_filter}
          AND oi.created_at > %s
        ORDER BY oi.created_at
    """, (last_ingested,))

    rows = mysql_cur.fetchall()
    mysql_cur.close()
    mysql_conn.close()

    print_info(f"Fetched {len(rows):,} new order items from MySQL")

    if not rows:
        print_ok("Nothing new to ingest.")
        pg.close()
        return

    mtg_count   = sum(1 for r in rows if r["name"].startswith("Magic löskort") or r["name"].startswith("MTG:"))
    other_count = len(rows) - mtg_count
    print_info(f"  MTG: {mtg_count:,}  |  Other games: {other_count:,}")

    insert_sql = """
        INSERT INTO bronze.order_items (
            id, order_id, product_id, sku, name, quantity,
            price_wot, wholesale_price, order_status,
            is_instore, carrier_name, order_created_at, item_created_at, game
        ) VALUES %s
        ON CONFLICT (id) DO UPDATE SET
            order_status     = EXCLUDED.order_status,
            carrier_name     = EXCLUDED.carrier_name,
            game             = EXCLUDED.game,
            ingested_at      = NOW()
    """

    batch = [
        (
            r["id"], r["order_id"], r["product_id"],
            r["sku"], r["name"],
            int(r["quantity"]),
            float(r["price_wot"])       if r["price_wot"]       is not None else None,
            float(r["wholesale_price"]) if r["wholesale_price"]  is not None else None,
            r["order_status"],
            bool(r["is_instore"]),
            r["carrier_name"],
            r["order_created_at"],
            r["item_created_at"],
            "MTG" if (r["name"].startswith("Magic löskort") or r["name"].startswith("MTG:")) else "Other",
        )
        for r in rows
    ]

    with pg.cursor() as cur:
        psycopg2.extras.execute_values(cur, insert_sql, batch, page_size=500)
        pg.commit()

    print_ok(f"Inserted/updated {len(batch):,} rows into bronze.order_items")
    pg.close()

if __name__ == "__main__":
    import sys as _sys
    if "--backfill-mtg-bulk" in _sys.argv:
        main._backfill_mtg_bulk = True
    main()
