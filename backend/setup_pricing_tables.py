import os, psycopg2
from dotenv import load_dotenv
load_dotenv()

conn = psycopg2.connect(
    host=os.getenv("PG_HOST","localhost"), port=int(os.getenv("PG_PORT",5432)),
    database=os.getenv("PG_DATABASE","mtg"), user=os.getenv("PG_USER","postgres"),
    password=os.getenv("PG_PASSWORD","")
)
cur = conn.cursor()

# Create pricing_rules table
cur.execute("""
CREATE TABLE IF NOT EXISTS bronze.pricing_rules (
    id          SERIAL PRIMARY KEY,
    category    TEXT NOT NULL,
    rule_key    TEXT NOT NULL,
    label       TEXT NOT NULL,
    value       NUMERIC NOT NULL,
    suffix      TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0,
    changed_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    changed_by  TEXT,
    UNIQUE (category, rule_key)
)
""")

# Create pricing_ranges table
cur.execute("""
CREATE TABLE IF NOT EXISTS bronze.pricing_ranges (
    id           SERIAL PRIMARY KEY,
    range_min    NUMERIC NOT NULL,
    range_max    NUMERIC,
    magic_number NUMERIC NOT NULL,
    fixed_sek    NUMERIC,
    label        TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 0,
    changed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    changed_by   TEXT
)
""")

# Seed pricing_rules — buy_valuation
buy_valuation_rows = [
    ("buy_valuation", "base_pct",            "Base value % of trend price",              80,   "%",      1),
    ("buy_valuation", "commons_min_eur",      "Common/uncommon zero-value threshold",      0.25, "EUR",    2),
    ("buy_valuation", "stock_threshold_low",  "Stock threshold (low sales)",              20,   "units",  3),
    ("buy_valuation", "stock_threshold_mid",  "Stock threshold (medium sales, 5-9/yr)",   30,   "units",  4),
    ("buy_valuation", "stock_threshold_high", "Stock threshold (high sales, 10+/yr)",     40,   "units",  5),
    ("buy_valuation", "demand_bonus",         "Out-of-stock demand bonus multiplier",     1.10, "x",      6),
    ("buy_valuation", "demand_min_sold",      "Minimum sold last year for demand bonus",   4,   "sold/yr",7),
    ("buy_valuation", "cond_fn",              "Condition FN multiplier",                  0.90, "x",      8),
    ("buy_valuation", "cond_gd",              "Condition GD multiplier",                  0.80, "x",      9),
    ("buy_valuation", "cond_pr",              "Condition PR multiplier",                  0.70, "x",     10),
    ("buy_valuation", "lang_penalty",         "Non-English language penalty",             0.80, "x",     11),
]

for category, rule_key, label, value, suffix, sort_order in buy_valuation_rows:
    cur.execute("""
        INSERT INTO bronze.pricing_rules (category, rule_key, label, value, suffix, sort_order)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (category, rule_key) DO NOTHING
    """, (category, rule_key, label, value, suffix, sort_order))

# Seed pricing_rules — buy_multiplier
buy_multiplier_rows = [
    ("buy_multiplier", "trade_cards",    "Trade for MTG cards",      1.00, "x", 1),
    ("buy_multiplier", "trade_products", "Trade for other products", 0.70, "x", 2),
    ("buy_multiplier", "trade_cash",     "Cash payout",              0.50, "x", 3),
]

for category, rule_key, label, value, suffix, sort_order in buy_multiplier_rows:
    cur.execute("""
        INSERT INTO bronze.pricing_rules (category, rule_key, label, value, suffix, sort_order)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (category, rule_key) DO NOTHING
    """, (category, rule_key, label, value, suffix, sort_order))

# Seed pricing_rules — sell_condition
sell_condition_rows = [
    ("sell_condition", "disc_mt",   "Condition MT discount",      0.00, "%", 1),
    ("sell_condition", "disc_nm",   "Condition NM discount",      0.00, "%", 2),
    ("sell_condition", "disc_vf",   "Condition VF discount",      0.10, "%", 3),
    ("sell_condition", "disc_fn",   "Condition FN discount",      0.10, "%", 4),
    ("sell_condition", "disc_vg",   "Condition VG discount",      0.10, "%", 5),
    ("sell_condition", "disc_gd",   "Condition GD discount",      0.15, "%", 6),
    ("sell_condition", "disc_fr",   "Condition FR discount",      0.20, "%", 7),
    ("sell_condition", "disc_pr",   "Condition PR discount",      0.25, "%", 8),
    ("sell_condition", "disc_null", "Unknown condition discount",  0.10, "%", 9),
]

for category, rule_key, label, value, suffix, sort_order in sell_condition_rows:
    cur.execute("""
        INSERT INTO bronze.pricing_rules (category, rule_key, label, value, suffix, sort_order)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (category, rule_key) DO NOTHING
    """, (category, rule_key, label, value, suffix, sort_order))

# Seed pricing_ranges — only if table is empty
cur.execute("SELECT COUNT(*) FROM bronze.pricing_ranges")
count = cur.fetchone()[0]
if count == 0:
    pricing_ranges_rows = [
        (1,  0,      0.24,   1.74, 5,    "Under \u20ac0.25 (min 5 SEK)"),
        (2,  0.25,   0.50,   3.48, None, "\u20ac0.25 \u2013 \u20ac0.50"),
        (3,  0.50,   1.00,   2.61, None, "\u20ac0.50 \u2013 \u20ac1.00"),
        (4,  1.00,   5.00,   1.74, None, "\u20ac1.00 \u2013 \u20ac5.00"),
        (5,  5.00,  10.00,   1.65, None, "\u20ac5.00 \u2013 \u20ac10.00"),
        (6, 10.00,  20.00,   1.57, None, "\u20ac10.00 \u2013 \u20ac20.00"),
        (7, 20.00,  50.00,   1.46, None, "\u20ac20.00 \u2013 \u20ac50.00"),
        (8, 50.00, 100.00,   1.30, None, "\u20ac50 \u2013 \u20ac100"),
        (9, 100.00, 500.00,  1.20, None, "\u20ac100 \u2013 \u20ac500"),
        (10, 500.00, None,   1.10, None, "\u20ac500+"),
    ]
    for sort_order, range_min, range_max, magic_number, fixed_sek, label in pricing_ranges_rows:
        cur.execute("""
            INSERT INTO bronze.pricing_ranges
                (sort_order, range_min, range_max, magic_number, fixed_sek, label)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (sort_order, range_min, range_max, magic_number, fixed_sek, label))
    print(f"Inserted {len(pricing_ranges_rows)} pricing ranges.")
else:
    print(f"pricing_ranges already has {count} rows — skipping seed.")

conn.commit()
cur.close()
conn.close()
print("Done. pricing_rules and pricing_ranges tables created and seeded.")
