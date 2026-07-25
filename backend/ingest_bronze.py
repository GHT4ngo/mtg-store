import requests
import psycopg2
import psycopg2.extras
import gzip
import ijson
import json
import os
import sys
import time
from datetime import datetime, date, timedelta
from decimal import Decimal
from dotenv import load_dotenv
load_dotenv()

# ============================================================
#  TERMINAL UI HELPERS
# ============================================================

GREEN   = "\033[32m"
CYAN    = "\033[36m"
YELLOW  = "\033[33m"
RED     = "\033[31m"
WHITE   = "\033[97m"
DIM     = "\033[2m"
BOLD    = "\033[1m"
RESET   = "\033[0m"

BANNER = r"""
____________________ ________    _______  _____________________
\______   \______   \\_____  \   \      \ \____    /\_   _____/
 |    |  _/|       _/ /   |   \  /   |   \  /     /  |    __)_
 |    |   \|    |   \/    |    \/    |    \/     /_  |        \
 |______  /|____|_  /\_______  /\____|__  /_______ \/_______  /
        \/        \/         \/         \/        \/        \/
         [ Bronze Layer Ingestion Pipeline ]
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

def spinner_download(url, local_file, label):
    """Download with a live size counter."""
    frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
    r = requests.get(url, stream=True, timeout=60)
    r.raise_for_status()
    total_size = int(r.headers.get("content-length", 0))
    downloaded = 0
    frame_i = 0
    with open(local_file, "wb") as f:
        for chunk in r.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)
            downloaded += len(chunk)
            mb = downloaded / 1024 / 1024
            total_mb = total_size / 1024 / 1024 if total_size else 0
            spin = frames[frame_i % len(frames)]
            if total_size:
                sys.stdout.write(f"\r  {GREEN}{spin}{RESET}  {label}: {mb:.1f} MB / {total_mb:.1f} MB  ")
            else:
                sys.stdout.write(f"\r  {GREEN}{spin}{RESET}  {label}: {mb:.1f} MB downloaded  ")
            sys.stdout.flush()
            frame_i += 1
    print(f"\r  {GREEN}✔{RESET}  {label}: {downloaded/1024/1024:.1f} MB downloaded" + " " * 20)
    return downloaded

# ============================================================
#  CONFIGURATION
# ============================================================

DB_CONFIG = {
    "host":     os.getenv("PG_HOST", "localhost"),
    "port":     int(os.getenv("PG_PORT", 5432)),
    "database": os.getenv("PG_DATABASE", "mtg"),
    "user":     os.getenv("PG_USER", "postgres"),
    "password": os.getenv("PG_PASSWORD", ""),
}

DATA_DIR = os.getenv("DATA_DIR", "data")
os.makedirs(DATA_DIR, exist_ok=True)

CARDMARKET_URL = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json"
SCRYFALL_MANIFEST = "https://api.scryfall.com/bulk-data"

RIKSBANK_PAIRS = [
    ("SEKEURPMI", "SEK", "EUR/SEK"),
    ("SEKUSDPMI", "SEK", "USD/SEK"),
]

# ============================================================
#  HELPERS
# ============================================================

def is_file_updated(url, local_file):
    """Returns True if remote file is newer than cached version."""
    lastmod_file = local_file + ".lastmod"
    try:
        r = requests.head(url, timeout=15)
        remote_lm = r.headers.get("Last-Modified")
        if remote_lm and os.path.exists(lastmod_file):
            with open(lastmod_file, "r") as f:
                if f.read().strip() == remote_lm:
                    return False
        if remote_lm:
            with open(lastmod_file, "w") as f:
                f.write(remote_lm)
    except Exception:
        pass
    return True

def get_scryfall_url(bulk_type="default_cards"):
    r = requests.get(SCRYFALL_MANIFEST, timeout=15)
    r.raise_for_status()
    for item in r.json()["data"]:
        if item["type"] == bulk_type:
            return item["download_uri"], item["updated_at"]
    raise ValueError(f"Bulk type '{bulk_type}' not found in Scryfall manifest")

# ============================================================
#  INGESTION FUNCTIONS
# ============================================================

def ingest_cardmarket(conn):
    print_section("1 / 3 — Cardmarket Price Guide")

    local_file = os.path.join(DATA_DIR, "price_guide_1.json")

    if is_file_updated(CARDMARKET_URL, local_file) or not os.path.exists(local_file):
        print_info("Downloading price guide from Cardmarket S3...")
        spinner_download(CARDMARKET_URL, local_file, "price_guide_1.json")
    else:
        print_ok("Cached file is up to date, skipping download")

    print_info("Parsing JSON...")
    with open(local_file, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # File is either a list or {"priceGuides": [...]}
    if isinstance(raw, list):
        items = raw
    else:
        items = raw.get("priceGuides", [])

    total = len(items)
    print_ok(f"Parsed {total:,} rows")

    today = date.today()
    cur = conn.cursor()

    # Delete today's rows to allow clean re-run
    cur.execute("DELETE FROM bronze.cardmarket_prices WHERE loaded_date = %s", (today,))
    deleted = cur.rowcount
    if deleted:
        print_warn(f"Removed {deleted:,} existing rows for today (re-run mode)")

    insert_sql = """
        INSERT INTO bronze.cardmarket_prices (
            idproduct, avg, low, trend, avg1, avg7, avg30,
            avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil,
            loaded_date
        ) VALUES %s
    """

    batch = []
    batch_size = 5000
    inserted = 0

    for i, p in enumerate(items):
        batch.append((
            int(p["idProduct"]) if p.get("idProduct") is not None else None,
            p.get("avg"),
            p.get("low"),
            p.get("trend"),
            p.get("avg1"),
            p.get("avg7"),
            p.get("avg30"),
            p.get("avg-foil"),
            p.get("low-foil"),
            p.get("trend-foil"),
            p.get("avg1-foil"),
            p.get("avg7-foil"),
            p.get("avg30-foil"),
            today
        ))

        if len(batch) >= batch_size:
            psycopg2.extras.execute_values(cur, insert_sql, batch)
            conn.commit()
            inserted += len(batch)
            batch = []
            progress_bar(inserted, total, label="rows inserted")

    if batch:
        psycopg2.extras.execute_values(cur, insert_sql, batch)
        conn.commit()
        inserted += len(batch)

    progress_bar(inserted, total, label="rows inserted")
    print_ok(f"Cardmarket prices loaded: {inserted:,} rows for {today}")
    cur.close()


def ingest_scryfall(conn):
    print_section("2 / 3 — Scryfall Default Cards")

    print_info("Fetching Scryfall bulk-data manifest...")
    scryfall_url, updated_at = get_scryfall_url("default_cards")
    print_ok(f"Latest file updated at: {updated_at}")

    filename = scryfall_url.split("/")[-1]
    local_file = os.path.join(DATA_DIR, filename)

    if is_file_updated(scryfall_url, local_file) or not os.path.exists(local_file):
        print_info(f"Downloading {filename} (this may take a while)...")
        spinner_download(scryfall_url, local_file, filename)
    else:
        print_ok("Cached Scryfall file is up to date, skipping download")

    print_info("Streaming and parsing cards into bronze (this takes a few minutes)...")

    cur = conn.cursor()

    # Truncate bronze table for a full refresh — Scryfall is the system of record
    cur.execute("TRUNCATE TABLE bronze.scryfall_cards")
    conn.commit()
    print_warn("Truncated bronze.scryfall_cards for full refresh")

    insert_sql = """
        INSERT INTO bronze.scryfall_cards (scryfall_id, cardmarket_id, raw_data, loaded_at)
        VALUES %s
    """

    KEEP_FIELDS = {
        "id", "oracle_id", "cardmarket_id", "name", "lang",
        "released_at", "image_uris", "mana_cost", "cmc", "type_line",
        "oracle_text", "colors", "color_identity", "keywords",
        "legalities", "games", "foil", "nonfoil", "finishes",
        "oversized", "promo", "reprint", "set_id", "set", "set_name",
        "set_type", "collector_number", "digital", "rarity",
        "artist", "border_color", "frame", "full_art", "textless",
        "prices", "related_uris", "purchase_uris", "card_faces"
    }

    open_fn = gzip.open if local_file.endswith(".gz") else open
    batch = []
    batch_size = 2000
    inserted = 0
    now = datetime.now()

    with open_fn(local_file, "rt", encoding="utf-8") as f:
        for card in ijson.items(f, "item"):
            scryfall_id   = card.get("id")
            raw_cm = card.get("cardmarket_id")
            cardmarket_id = int(raw_cm) if raw_cm is not None else None

            # Store only the fields we care about to keep JSONB lean
            slim = {k: v for k, v in card.items() if k in KEEP_FIELDS}

            batch.append((
                scryfall_id,
                cardmarket_id,
                json.dumps(slim, ensure_ascii=False, default=str),
                now
            ))

            if len(batch) >= batch_size:
                psycopg2.extras.execute_values(cur, insert_sql, batch)
                conn.commit()
                inserted += len(batch)
                batch = []
                progress_bar(inserted, inserted, label=f"~{inserted:,} cards inserted")

    if batch:
        psycopg2.extras.execute_values(cur, insert_sql, batch)
        conn.commit()
        inserted += len(batch)

    progress_bar(inserted, inserted, label="cards inserted")
    print_ok(f"Scryfall cards loaded: {inserted:,} rows")
    cur.close()


def ingest_exchange_rates(conn):
    print_section("3 / 3 — Riksbank Exchange Rates")

    cur = conn.cursor()

    for series_id, series_id2, label in RIKSBANK_PAIRS:
        fetched = False
        for days_back in range(10):
            check_date = (datetime.today() - timedelta(days=days_back)).date()
            url = (
                f"https://api.riksbank.se/swea/v1/CrossRates/"
                f"{series_id}/{series_id2}/{check_date.isoformat()}"
            )
            try:
                r = requests.get(url, timeout=15)
                if r.status_code == 200 and r.json():
                    data = r.json()[0]
                    rate_value = float(data["value"])
                    rate_date  = data["date"]

                    cur.execute("""
                        INSERT INTO bronze.exchange_rates (series_id, rate_date, rate_value, loaded_at)
                        VALUES (%s, %s, %s, NOW())
                        ON CONFLICT (series_id, rate_date) DO UPDATE
                            SET rate_value = EXCLUDED.rate_value,
                                loaded_at  = EXCLUDED.loaded_at
                    """, (label, rate_date, rate_value))
                    conn.commit()

                    print_ok(f"{label}: {rate_value:.4f}  (date: {rate_date})")
                    fetched = True
                    break
            except Exception as e:
                print_warn(f"Riksbank request failed for {label} on {check_date}: {e}")

        if not fetched:
            print_err(f"Could not fetch rate for {label} — check Riksbank API")

    cur.close()


# ============================================================
#  UNIQUE CONSTRAINT for exchange rates (run once, safe to re-run)
# ============================================================

def ensure_exchange_rate_constraint(conn):
    cur = conn.cursor()
    cur.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_exchange_rates_series_date'
            ) THEN
                ALTER TABLE bronze.exchange_rates
                ADD CONSTRAINT uq_exchange_rates_series_date
                UNIQUE (series_id, rate_date);
            END IF;
        END
        $$;
    """)
    conn.commit()
    cur.close()


# ============================================================
#  MAIN
# ============================================================

def main():
    print_banner()
    start = time.time()

    print_info(f"Run started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print_info(f"Data directory: {DATA_DIR}")

    # Connect
    print_info("Connecting to PostgreSQL...")
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        print_ok("Connected to PostgreSQL")
    except Exception as e:
        print_err(f"Database connection failed: {e}")
        sys.exit(1)

    ensure_exchange_rate_constraint(conn)

    try:
        ingest_cardmarket(conn)
        ingest_scryfall(conn)
        ingest_exchange_rates(conn)
    except Exception as e:
        print_err(f"Pipeline error: {e}")
        conn.close()
        sys.exit(1)

    conn.close()

    elapsed = time.time() - start
    print()
    print(CYAN + "─" * 60 + RESET)
    print(GREEN + BOLD + f"  ✔  All bronze layers updated in {elapsed:.1f}s" + RESET)
    print(CYAN + "─" * 60 + RESET)
    print()


if __name__ == "__main__":
    main()
