import mysql.connector
import psycopg2
import psycopg2.extras
import sys
import os
import time
from datetime import datetime, date
from dotenv import load_dotenv
load_dotenv()

# ============================================================
#  TERMINAL UI HELPERS  (same style as ingest_bronze.py)
# ============================================================

GREEN  = "\033[32m"
CYAN   = "\033[36m"
YELLOW = "\033[33m"
RED    = "\033[31m"
DIM    = "\033[2m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

BANNER = r"""
  ____________________________  _________  ____  __.   ______________.___._______  _________
 /   _____/\__    ___/\_____  \ \_   ___ \|    |/ _|  /   _____/\__  |   |\      \ \_   ___ \
 \_____  \   |    |    /   |   \/    \  \/|      <    \_____  \  /   |   |/   |   \/    \  \/
 /        \  |    |   /    |    \     \___|    |  \   /        \ \____   /    |    \     \____
/_______  /  |____|   \_______  /\______  /____|__ \ /_______  / / ______\____|__  /\______  /
        \/                    \/        \/        \/         \/  \/              \/        \/
         [ Stock Layer — MySQL → PostgreSQL Bronze ]
"""

def print_banner():
    print(GREEN + BOLD + BANNER + RESET)

def print_section(title):
    width = 60
    print()
    print(CYAN + "─" * width + RESET)
    print(CYAN + BOLD + f"  {title}" + RESET)
    print(CYAN + "─" * width + RESET)

def print_ok(msg):
    print(f"  {GREEN}✔{RESET}  {msg}")

def print_info(msg):
    print(f"  {CYAN}→{RESET}  {msg}")

def print_warn(msg):
    print(f"  {YELLOW}⚠{RESET}  {msg}")

def print_err(msg):
    print(f"  {RED}✘{RESET}  {msg}")

def progress_bar(current, total, width=40, label=""):
    pct = current / total if total > 0 else 0
    filled = int(width * pct)
    bar = GREEN + "█" * filled + DIM + "░" * (width - filled) + RESET
    sys.stdout.write(f"\r  [{bar}] {GREEN}{current:,}{RESET}/{total:,}  {DIM}{label}{RESET}  ")
    sys.stdout.flush()
    if current >= total:
        print()

# ============================================================
#  CONFIGURATION
# ============================================================

MYSQL_CONFIG = {
    "host":     os.getenv("MYSQL_HOST", "localhost"),
    "port":     int(os.getenv("MYSQL_PORT", 3306)),
    "database": os.getenv("MYSQL_DATABASE", "alphaspel"),
    "user":     os.getenv("MYSQL_USER", "root"),
    "password": os.getenv("MYSQL_PASSWORD", ""),
}

PG_CONFIG = {
    "host":     os.getenv("PG_HOST", "localhost"),
    "port":     int(os.getenv("PG_PORT", 5432)),
    "database": os.getenv("PG_DATABASE", "mtg"),
    "user":     os.getenv("PG_USER", "postgres"),
    "password": os.getenv("PG_PASSWORD", ""),
}

BATCH_SIZE = 5000

MYSQL_QUERY = """
    SELECT
        REGEXP_REPLACE(reference, '^[#!$]+', '') AS reference,
        reference                                  AS reference_raw,
        name,
        COALESCE(stock_a, 0) AS stock_a,
        COALESCE(stock_b, 0) AS stock_b,
        COALESCE(stock_c, 0) AS stock_c,
        COALESCE(stock_a, 0) + COALESCE(stock_b, 0) + COALESCE(stock_c, 0) AS total_stock,
        `condition`,
        COALESCE(damaged, 0)    AS damaged,
        reduction_percent,
        reduction_start,
        reduction_end,
        sold_total,
        sold_last_year,
        long_description,
        is_active,
        price_wt
    FROM alphaspel.catalog_product
    WHERE (name LIKE '%Magic%löskort%' OR name LIKE '%Magic%Löskort%')
      AND is_active = 1
"""

# ============================================================
#  MAIN INGESTION
# ============================================================

def ingest_stock(mysql_conn, pg_conn):
    print_section("Stock Sync — MySQL alphaspel → bronze.mysql_stock")

    # --- Fetch from MySQL ---
    print_info("Querying MySQL for Magic card stock...")
    mysql_cur = mysql_conn.cursor(dictionary=True)
    mysql_cur.execute(MYSQL_QUERY)
    rows = mysql_cur.fetchall()
    mysql_cur.close()
    total = len(rows)
    print_ok(f"Fetched {total:,} rows from MySQL")

    if total == 0:
        print_warn("No rows returned — check MySQL query or connection")
        return

    # --- Load into PostgreSQL bronze ---
    today = date.today()
    pg_cur = pg_conn.cursor()

    # Delete today's load to allow clean re-run
    pg_cur.execute(
        "DELETE FROM bronze.mysql_stock WHERE loaded_date = %s", (today,)
    )
    deleted = pg_cur.rowcount
    if deleted:
        print_warn(f"Removed {deleted:,} existing rows for today (re-run mode)")
    pg_conn.commit()

    insert_sql = """
        INSERT INTO bronze.mysql_stock
            (reference, name, stock_a, stock_b, stock_c,
            condition, damaged, reduction_percent, reduction_start, reduction_end,
            sold_total, sold_last_year, long_description, is_active, price_wt,
            loaded_date)
        VALUES %s
    """

    batch   = []
    inserted = 0

    for row in rows:
        batch.append((
            row["reference"],
            row["name"],
            int(row["stock_a"]),
            int(row["stock_b"]),
            int(row["stock_c"]),
            row["condition"],
            int(row["damaged"]),
            row["reduction_percent"],
            row["reduction_start"],
            row["reduction_end"],
            row["sold_total"],
            row["sold_last_year"],
            row["long_description"],
            int(row["is_active"]),
            row["price_wt"],
            today
        ))

        if len(batch) >= BATCH_SIZE:
            psycopg2.extras.execute_values(pg_cur, insert_sql, batch)
            pg_conn.commit()
            inserted += len(batch)
            batch = []
            progress_bar(inserted, total, label="rows inserted")

    if batch:
        psycopg2.extras.execute_values(pg_cur, insert_sql, batch)
        pg_conn.commit()
        inserted += len(batch)

    progress_bar(inserted, total, label="rows inserted")
    pg_cur.close()

    # --- Summary stats ---
    pg_cur = pg_conn.cursor()
    pg_cur.execute("""
        SELECT
            COUNT(*)                                    AS total_rows,
            COUNT(CASE WHEN total_stock > 0 THEN 1 END) AS in_stock,
            SUM(total_stock)                            AS total_units
        FROM bronze.mysql_stock
        WHERE loaded_date = %s
    """, (today,))
    stats = pg_cur.fetchone()
    pg_cur.close()

    print_ok(f"Rows loaded  : {stats[0]:,}")
    print_ok(f"Cards in stock: {stats[1]:,}")
    print_ok(f"Total units  : {stats[2]:,}")


# ============================================================
#  MAIN
# ============================================================

def main():
    print_banner()
    start = time.time()
    print_info(f"Run started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # Connect MySQL
    print_info("Connecting to MySQL (alphaspel)...")
    try:
        mysql_conn = mysql.connector.connect(**MYSQL_CONFIG)
        print_ok("Connected to MySQL")
    except Exception as e:
        print_err(f"MySQL connection failed: {e}")
        sys.exit(1)

    # Connect PostgreSQL
    print_info("Connecting to PostgreSQL (mtg)...")
    try:
        pg_conn = psycopg2.connect(**PG_CONFIG)
        print_ok("Connected to PostgreSQL")
    except Exception as e:
        print_err(f"PostgreSQL connection failed: {e}")
        mysql_conn.close()
        sys.exit(1)

    try:
        ingest_stock(mysql_conn, pg_conn)
    except Exception as e:
        print_err(f"Pipeline error: {e}")
        mysql_conn.close()
        pg_conn.close()
        sys.exit(1)

    mysql_conn.close()
    pg_conn.close()

    elapsed = time.time() - start
    print()
    print(CYAN + "─" * 60 + RESET)
    print(GREEN + BOLD + f"  ✔  Stock sync complete in {elapsed:.1f}s" + RESET)
    print(CYAN + "─" * 60 + RESET)
    print()


if __name__ == "__main__":
    main()
