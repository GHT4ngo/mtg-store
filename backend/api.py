import re, os
import time as _time
from fastapi import FastAPI, Query, UploadFile, File, HTTPException
from pydantic import BaseModel
import csv, io, hashlib
from fastapi.middleware.cors import CORSMiddleware
import psycopg2
import psycopg2.extras
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

# ============================================================
#  CONFIGURATION
# ============================================================

PG_CONFIG = {
    "host":     os.getenv("PG_HOST", "localhost"),
    "port":     int(os.getenv("PG_PORT", 5432)),
    "database": os.getenv("PG_DATABASE", "mtg"),
    "user":     os.getenv("PG_USER", "postgres"),
    "password": os.getenv("PG_PASSWORD", ""),
}

app = FastAPI(title="MTG Store API", version="1.0.0")

# Allow all origins so Lovable can call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MYSQL_CONFIG = {
    "host":     os.getenv("MYSQL_HOST", "localhost"),
    "port":     int(os.getenv("MYSQL_PORT", 3306)),
    "database": os.getenv("MYSQL_DATABASE", "alphaspel"),
    "user":     os.getenv("MYSQL_USER", "root"),
    "password": os.getenv("MYSQL_PASSWORD", ""),
}

# ============================================================
#  PRICING CONFIG CACHE
# ============================================================
_pricing_cache: dict = {}
_pricing_cache_ts: float = 0.0
_PRICING_TTL = 60  # seconds

def _load_pricing() -> dict:
    """Load pricing rules and ranges from DB, cached for 60s."""
    global _pricing_cache, _pricing_cache_ts
    now = _time.time()
    if _pricing_cache and now - _pricing_cache_ts < _PRICING_TTL:
        return _pricing_cache

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT category, rule_key, value, is_active
                FROM bronze.pricing_rules
                ORDER BY category, sort_order
            """)
            rules_rows = cur.fetchall()

            cur.execute("""
                SELECT range_min, range_max, magic_number, fixed_sek
                FROM bronze.pricing_ranges
                WHERE is_active = TRUE
                ORDER BY sort_order
            """)
            ranges_rows = cur.fetchall()
    finally:
        conn.close()

    rules = {}
    for r in rules_rows:
        cat = r["category"]
        if cat not in rules:
            rules[cat] = {}
        rules[cat][r["rule_key"]] = {"value": float(r["value"]), "is_active": r["is_active"]}

    ranges = [dict(r) for r in ranges_rows]

    _pricing_cache = {"rules": rules, "ranges": ranges}
    _pricing_cache_ts = now
    return _pricing_cache


def _build_range_anchors(ranges, rate):
    """
    Pre-compute (lower_sek, upper_sek) anchors for each range using
    piecewise linear interpolation. The lower bound of each range inherits
    the upper bound of the previous range, eliminating price cliffs at
    boundaries where the magic number drops.

    Returns sorted list of (range_min, range_max, lower_sek, upper_sek, magic).
    """
    sorted_r = sorted(ranges, key=lambda x: float(x["range_min"]))
    anchors = []
    prev_upper = 0.0

    for r in sorted_r:
        rmin   = float(r["range_min"])
        rmax   = float(r["range_max"]) if r["range_max"] is not None else None
        magic  = float(r["magic_number"])
        fixed  = float(r["fixed_sek"]) if r["fixed_sek"] is not None else None

        if fixed is not None:
            # Fixed floor range (e.g. 0-0.24 = 5 SEK) — always returns fixed_sek
            lower_sek = fixed
            upper_sek = fixed
        else:
            # Lower bound: max of direct formula and previous range's upper (no cliff down)
            direct_lower = rmin * rate * magic
            lower_sek = max(direct_lower, prev_upper)
            upper_sek = (rmax * rate * magic) if rmax is not None else None

        anchors.append((rmin, rmax, lower_sek, upper_sek, magic, fixed))
        prev_upper = upper_sek if upper_sek is not None else (lower_sek + rmin * rate * magic)

    return anchors


def _calc_sell_price(price_eur, eur_sek_rate, ranges, rarity, sold_last_year=None, sell_minimums=None):
    """Calculate sell price in SEK using piecewise linear interpolation across
    pricing_ranges. Prices are guaranteed monotonically increasing — no cliff
    at range boundaries even when the magic number drops."""
    if not price_eur or price_eur <= 0:
        return None
    price_eur = float(price_eur)
    rate = float(eur_sek_rate) if eur_sek_rate else 11.5

    anchors = _build_range_anchors(ranges, rate)

    matched = None
    for entry in reversed(anchors):
        rmin, rmax, lower_sek, upper_sek, magic, fixed = entry
        if price_eur >= rmin:
            matched = entry
            break

    if not matched:
        return None

    rmin, rmax, lower_sek, upper_sek, magic, fixed = matched

    if fixed is not None:
        sek = fixed
    elif rmax is None:
        # Last (unbounded) range: extend linearly from lower_sek using magic slope
        sek = lower_sek + (price_eur - rmin) * rate * magic
    else:
        # Linear interpolation between the clamped lower and upper anchors
        t = (price_eur - rmin) / (rmax - rmin)
        sek = lower_sek + t * (upper_sek - lower_sek)

    # Minimum price from DB rules (or hardcoded fallback)
    if sell_minimums:
        def _sm(key, default):
            rule = sell_minimums.get(key, {})
            return float(rule["value"]) if rule and rule.get("is_active", True) else default
        threshold = int(_sm("min_sold_threshold", 1))
        if rarity in ("rare", "mythic"):
            sold = sold_last_year if sold_last_year is not None else 0
            min_price = _sm("min_rare_mythic_active", 15) if sold > threshold else _sm("min_rare_mythic_slow", 10)
        else:
            min_price = _sm("min_common_uncommon", 5)
    else:
        min_price = 10 if rarity in ("rare", "mythic") else 5

    # Round to nearest 5
    return float(max(round(sek / 5) * 5, min_price))


def _apply_sell_condition_discount(base_price, condition, sell_conditions):
    """Apply sell condition discount from pricing_rules."""
    if base_price is None:
        return None
    key = f"disc_{(condition or 'null').lower()}"
    disc = sell_conditions.get(key, sell_conditions.get("disc_null", {"value": 0.10}))
    if not disc["is_active"]:
        return base_price
    discounted = base_price * (1 - float(disc["value"]))
    return float(max(round(discounted / 5) * 5, 5))


def get_mysql_conn():
    import mysql.connector
    return mysql.connector.connect(**MYSQL_CONFIG, autocommit=True)

# Condition → price discount, mirrors stock_parsed.sql logic.
CONDITION_DISCOUNT = {"MT": 0.00, "NM": 0.00, "VF": 0.10, "FN": 0.10, "VG": 0.10,
                      "GD": 0.15, "FR": 0.20, "PR": 0.25}

# Canonical Manabox/Cardmarket → LGS condition mapping.
# Used everywhere CSV/trade-in rows are parsed. "damaged" also sets damaged=1 in MySQL.
MANABOX_TO_ALPHASPEL_CONDITION = {
    "mint":             "MT",
    "near_mint":        "NM",
    "excellent":        "VF",
    "good":             "FN",
    "lightly_played":   "FN",
    "light_play":       "FN",
    "played":           "GD",
    "heavily_played":   "FR",
    "poor":             "PR",
    "damaged":          "PR",
    # short codes
    "mt": "MT", "nm": "NM", "ex": "VF",
    "gd": "FN", "lp": "FN",
    "pl": "GD", "hp": "FR",
    "po": "PR", "pr": "PR", "dmg": "PR",
}

# ============================================================
#  DB HELPER
# ============================================================

def get_conn():
    return psycopg2.connect(**PG_CONFIG)

def fetchall(sql, params=None):
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, params or [])
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [dict(r) for r in rows]

def apply_delta(cards: list) -> list:
    """Overlay bronze.stock_delta so frontend sees latest stock immediately."""
    if not cards:
        return cards
    try:
        refs = [(c["reference"], c["condition"]) for c in cards
                if c.get("reference") and c.get("condition")]
        if not refs:
            return cards
        placeholders = ",".join(["(%s,%s)"] * len(refs))
        flat = [v for pair in refs for v in pair]
        delta_rows = fetchall(
            f"SELECT reference, condition, stock_a FROM bronze.stock_delta"
            f" WHERE (reference, condition) IN ({placeholders})",
            flat
        )
        delta = {(r["reference"], r["condition"]): r["stock_a"] for r in delta_rows}
        for card in cards:
            key = (card.get("reference"), card.get("condition"))
            if key in delta:
                card["stock_a"]     = delta[key]
                card["in_stock"]    = delta[key] > 0
                card["total_stock"] = delta[key] + card.get("stock_b", 0) + card.get("stock_c", 0)
    except Exception as e:
        print(f"apply_delta error: {e}")
    return cards


def fetch_delta_new_cards(
    name_filter=None, set_filter=None, foil_filter=None,
    rarity_filter=None, color_filter=None, type_line_filter=None,
    oracle_text_filter=None, min_cmc=None, max_cmc=None,
    min_price=None, max_price=None,
) -> list:
    """Fetch cards that exist in stock_delta but not yet in gold_cards.
    These are cards created by import that haven't been through a dbt rebuild yet."""
    try:
        # Find delta references not in gold_cards
        rows = fetchall("""
            SELECT d.reference, d.condition, d.stock_a
            FROM bronze.stock_delta d
            WHERE NOT EXISTS (
                SELECT 1 FROM gold.gold_cards g
                WHERE g.reference = d.reference
                  AND g.condition = d.condition
            )
              AND d.stock_a > 0
        """)
        if not rows:
            return []

        cards = []
        for row in rows:
            ref       = row["reference"]
            condition = row["condition"]
            stock_a   = row["stock_a"]
            is_foil   = ref.endswith("-F")

            # Get scryfall data via silver_cards
            # For foil refs (ECL-105-F), strip the -F suffix to get base ref
            ref_base = ref[:-2] if ref.endswith("-F") else ref
            # Parse set_code and collector_number from reference (e.g. "HML-109" → "hml", "109")
            _parts = ref_base.split("-")
            _set_code = _parts[0].lower() if _parts else ""
            _coll_num = _parts[1] if len(_parts) > 1 else ""
            sc = fetchone("""
                SELECT sc.scryfall_id, sc.name, sc.set_code, sc.set_name,
                       sc.collector_number, sc.rarity, sc.type_line, sc.oracle_text,
                       sc.mana_cost, sc.cmc, sc.colors, sc.color_identity,
                       sc.artist, sc.image_url_normal, sc.image_url_small,
                       sc.image_url_back, sc.released_at,
                       sc.foil, sc.nonfoil, sc.full_art, sc.promo,
                       sc.price_avg_sek, sc.price_trend_sek,
                       sc.price_avg_foil_sek, sc.price_trend_foil_sek,
                       sc.sell_price_sek, sc.sell_price_foil_sek,
                       sc.price_avg_eur, sc.price_low_eur, sc.price_date,
                       sc.eur_sek_rate,
                       sc.cardmarket_id
                FROM silver.silver_cards sc
                WHERE LOWER(sc.set_code) = %s
                  AND sc.collector_number = %s
                LIMIT 1
            """, (_set_code, _coll_num))

            if not sc:
                    continue

            # Apply all active filters
            if name_filter and name_filter.lower() not in sc["name"].lower():
                continue
            if set_filter and sc["set_code"].lower() not in [s.lower() for s in set_filter]:
                continue
            if foil_filter is not None and foil_filter != is_foil:
                continue
            if rarity_filter and (sc.get("rarity") or "").lower() != rarity_filter.lower():
                continue
            if color_filter and color_filter.replace("%", "").upper() not in (sc.get("color_identity") or ""):
                continue
            if type_line_filter and type_line_filter.lower() not in (sc.get("type_line") or "").lower():
                continue
            if oracle_text_filter and oracle_text_filter.lower() not in (sc.get("oracle_text") or "").lower():
                continue
            _price = sc.get("sell_price_foil_sek") if is_foil else sc.get("sell_price_sek")
            if min_price is not None and (_price is None or _price < min_price):
                continue
            if max_price is not None and (_price is not None and _price > max_price):
                continue
            if min_cmc is not None and (sc.get("cmc") is None or sc.get("cmc") < min_cmc):
                continue
            if max_cmc is not None and (sc.get("cmc") is not None and sc.get("cmc") > max_cmc):
                continue

            cards.append({
                "scryfall_id":        sc["scryfall_id"],
                "cardmarket_id":      sc.get("cardmarket_id"),
                "name":               sc["name"],
                "set_code":           sc["set_code"],
                "set_name":           sc["set_name"],
                "collector_number":   sc["collector_number"],
                "rarity":             sc.get("rarity"),
                "type_line":          sc.get("type_line"),
                "mana_cost":          sc.get("mana_cost"),
                "cmc":                sc.get("cmc"),
                "colors":             sc.get("colors"),
                "color_identity":     sc.get("color_identity"),
                "artist":             sc.get("artist"),
                "image_url_normal":   sc.get("image_url_normal"),
                "image_url_small":    sc.get("image_url_small") or sc.get("image_url_normal"),
                "image_url_back":     sc.get("image_url_back"),
                "released_at":        sc.get("released_at"),
                "foil":               is_foil,
                "nonfoil":            not is_foil,
                "full_art":           sc.get("full_art") or False,
                "promo":              sc.get("promo") or False,
                "is_foil":            is_foil,
                "in_stock":           True,
                "total_stock":        stock_a,
                "stock_a":            stock_a,
                "stock_b":            0,
                "stock_c":            0,
                "price_avg_sek":      sc.get("price_avg_sek"),
                "price_trend_sek":    sc.get("price_trend_sek"),
                "price_avg_foil_sek": sc.get("price_avg_foil_sek"),
                "price_trend_foil_sek": sc.get("price_trend_foil_sek"),
                "sell_price_sek":     sc.get("sell_price_sek") if not is_foil else None,
                "sell_price_foil_sek": sc.get("sell_price_foil_sek") if is_foil else None,
                "price_avg_eur":      sc.get("price_avg_eur"),
                "price_low_eur":      sc.get("price_low_eur"),
                "price_date":         sc.get("price_date"),
                "eur_sek_rate":       sc.get("eur_sek_rate"),
                "reference":          ref,
                "condition":          condition,
                "condition_discount": CONDITION_DISCOUNT.get(condition, 0.10),
                "language":           "English",
                "special_foil_type":  None,
                "damaged":            False,
                "price_wt":           None,
                "reduction_percent":  None,
                "reduction_start":    None,
                "reduction_end":      None,
                "sold_total":         0,
                "sold_last_year":     0,
                "special_print":      False,
                "is_signed":          False,
                "data_quality":       "delta_new",
                "match_type":         "delta_new",
            })
        return cards
    except Exception as e:
        print(f"fetch_delta_new_cards error: {e}")
        return []


def fetch_corrected_cards(
    name_filter=None, set_filter=None, foil_filter=None,
    rarity_filter=None, color_filter=None, type_line_filter=None,
    oracle_text_filter=None, min_cmc=None, max_cmc=None,
) -> list:
    """Return cards that have a reference_correction but are not yet in gold_cards.
    Gives immediate sell visibility without waiting for a dbt rebuild."""
    try:
        corrections = fetchall("""
            SELECT rc.reference, rc.set_code, rc.collector_number
            FROM bronze.reference_corrections rc
            WHERE NOT EXISTS (
                SELECT 1 FROM gold.gold_cards g WHERE g.reference = rc.reference
            )
        """)
        if not corrections:
            return []

        cards = []
        for corr in corrections:
            ref    = corr["reference"]
            sc_key = corr["set_code"].lower()
            cn_key = corr["collector_number"].lstrip("0") or "0"  # match Scryfall's stripped format

            stock_row = fetchone("""
                SELECT stock_a, stock_b, stock_c, condition, name
                FROM bronze.mysql_stock
                WHERE reference = %s
                  AND loaded_date = (SELECT max(loaded_date) FROM bronze.mysql_stock)
                  AND is_active = 1
                LIMIT 1
            """, [ref])
            if not stock_row or (stock_row.get("stock_a") or 0) <= 0:
                continue

            is_foil   = ref.upper().endswith("-F")
            condition = stock_row.get("condition") or "NM"
            stock_a   = stock_row.get("stock_a") or 0
            _ms_name  = stock_row.get("name") or ""
            is_signed = "signed" in _ms_name.lower() or "signerad" in _ms_name.lower()

            sc = fetchone("""
                SELECT scryfall_id, name, set_code, set_name, collector_number,
                       rarity, type_line, oracle_text, mana_cost, cmc,
                       colors, color_identity, artist,
                       image_url_normal, image_url_small, image_url_back, released_at,
                       foil, nonfoil, full_art, promo,
                       price_avg_sek, price_trend_sek, price_avg_foil_sek, price_trend_foil_sek,
                       sell_price_sek, sell_price_foil_sek,
                       price_avg_eur, price_low_eur, price_trend_eur, price_trend_foil_eur,
                       price_date, eur_sek_rate, cardmarket_id
                FROM silver.silver_cards
                WHERE LOWER(set_code) = %s AND collector_number = %s
                LIMIT 1
            """, [sc_key, cn_key])
            if not sc:
                continue

            if name_filter      and name_filter.lower() not in sc["name"].lower():                  continue
            if set_filter       and sc["set_code"].lower() not in [s.lower() for s in set_filter]:  continue
            if foil_filter is not None and foil_filter != is_foil:                                  continue
            if rarity_filter    and (sc.get("rarity") or "").lower() != rarity_filter.lower():      continue
            if color_filter     and color_filter.replace("%","").upper() not in (sc.get("color_identity") or ""): continue
            if type_line_filter and type_line_filter.lower() not in (sc.get("type_line") or "").lower(): continue
            if oracle_text_filter and oracle_text_filter.lower() not in (sc.get("oracle_text") or "").lower(): continue
            if min_cmc is not None and (sc.get("cmc") is None or sc.get("cmc") < min_cmc): continue
            if max_cmc is not None and (sc.get("cmc") is not None and sc.get("cmc") > max_cmc): continue

            cards.append({
                "scryfall_id":          sc["scryfall_id"],
                "cardmarket_id":        sc.get("cardmarket_id"),
                "name":                 sc["name"],
                "set_code":             sc["set_code"],
                "set_name":             sc["set_name"],
                "collector_number":     sc["collector_number"],
                "rarity":               sc.get("rarity"),
                "type_line":            sc.get("type_line"),
                "mana_cost":            sc.get("mana_cost"),
                "cmc":                  sc.get("cmc"),
                "colors":               sc.get("colors"),
                "color_identity":       sc.get("color_identity"),
                "artist":               sc.get("artist"),
                "image_url_normal":     sc.get("image_url_normal"),
                "image_url_small":      sc.get("image_url_small") or sc.get("image_url_normal"),
                "image_url_back":       sc.get("image_url_back"),
                "released_at":          sc.get("released_at"),
                "foil":                 is_foil,
                "nonfoil":              not is_foil,
                "full_art":             sc.get("full_art") or False,
                "promo":                sc.get("promo") or False,
                "is_foil":              is_foil,
                "in_stock":             True,
                "total_stock":          stock_a,
                "stock_a":              stock_a,
                "stock_b":              stock_row.get("stock_b") or 0,
                "stock_c":              stock_row.get("stock_c") or 0,
                "price_avg_sek":        sc.get("price_avg_sek"),
                "price_trend_sek":      sc.get("price_trend_sek"),
                "price_avg_foil_sek":   sc.get("price_avg_foil_sek"),
                "price_trend_foil_sek": sc.get("price_trend_foil_sek"),
                "price_trend_eur":      sc.get("price_trend_eur"),
                "price_trend_foil_eur": sc.get("price_trend_foil_eur"),
                "sell_price_sek":       sc.get("sell_price_sek") if not is_foil else None,
                "sell_price_foil_sek":  sc.get("sell_price_foil_sek") if is_foil else None,
                "price_avg_eur":        sc.get("price_avg_eur"),
                "price_low_eur":        sc.get("price_low_eur"),
                "price_date":           sc.get("price_date"),
                "eur_sek_rate":         sc.get("eur_sek_rate"),
                "reference":            ref,
                "condition":            condition,
                "condition_discount":   CONDITION_DISCOUNT.get(condition, 0.10),
                "language":             "English",
                "special_foil_type":    None,
                "damaged":              False,
                "price_wt":             None,
                "reduction_percent":    None,
                "reduction_start":      None,
                "reduction_end":        None,
                "sold_total":           0,
                "sold_last_year":       0,
                "special_print":        None,
                "is_signed":            is_signed,
                "data_quality":         "correction",
                "match_type":           "correction",
            })
        return cards
    except Exception as e:
        print(f"fetch_corrected_cards error: {e}")
        return []


def _get_price_overrides() -> dict:
    """Return {(set_code, collector_number, is_foil): price_sek} for all manual overrides."""
    try:
        rows = fetchall("SELECT set_code, collector_number, is_foil, price_sek FROM bronze.price_overrides")
        return {(r["set_code"].lower(), r["collector_number"], bool(r["is_foil"])): float(r["price_sek"]) for r in rows}
    except Exception as e:
        print(f"_get_price_overrides error: {e}")
        return {}


def fetchone(sql, params=None):
    conn = get_conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, params or [])
    row = cur.fetchone()
    cur.close()
    conn.close()
    return dict(row) if row else None

def _round5(x: float) -> int:
    """Round a value to the nearest 5 SEK."""
    return int(round(x / 5) * 5)

# ============================================================
#  ENDPOINTS
# ============================================================

@app.get("/")
def root():
    return {"status": "MTG Store API is running"}


@app.get("/cards")
def get_cards(
    name:        Optional[str]  = Query(None, description="Search by card name"),
    q:           Optional[str]  = Query(None, description="Alias for name search"),
    set_code:    Optional[str]  = Query(None, description="Filter by set code e.g. BLB"),
    color:       Optional[str]  = Query(None, description="Filter by color identity e.g. W, U, B, R, G"),
    rarity:      Optional[str]  = Query(None, description="Filter by rarity: common, uncommon, rare, mythic"),
    type_line:   Optional[str]  = Query(None, description="Filter by type line e.g. Creature, Instant, Planeswalker"),
    oracle_text: Optional[str]  = Query(None, description="Search in oracle card text"),
    min_cmc:     Optional[float]= Query(None, description="Minimum converted mana cost"),
    max_cmc:     Optional[float]= Query(None, description="Maximum converted mana cost"),
    min_price:   Optional[float]= Query(None, description="Minimum sell price in SEK"),
    max_price:   Optional[float]= Query(None, description="Maximum sell price in SEK"),
    in_stock:    Optional[bool] = Query(None, description="Filter by stock availability"),
    foil:        Optional[bool] = Query(None, description="Filter foil cards"),
    page:        int            = Query(1,    ge=1,   description="Page number"),
    page_size:   int            = Query(20,   ge=1, le=100, description="Results per page"),
):
    filters = []
    params  = []

    name = name or q  # accept both ?name= and ?q=
    if name:
        # Normalize both sides: strip everything that isn't a letter, digit, or space.
        # Allows "Farrels Zealot", "Farrel´s Zealot", "Ach Hans Run" to all match correctly.
        name_norm = re.sub(r"[^a-z0-9 ]", "", name.lower())
        filters.append("regexp_replace(lower(name), '[^a-z0-9 ]', '', 'g') ILIKE %s")
        params.append(f"%{name_norm}%")

    if set_code:
        # Support comma-separated set codes for group filtering e.g. "blb,lci,dsk"
        codes = [c.strip().lower() for c in set_code.split(",") if c.strip()]
        if len(codes) == 1:
            filters.append("lower(set_code) = %s")
            params.append(codes[0])
        else:
            placeholders = ",".join(["%s"] * len(codes))
            filters.append(f"lower(set_code) IN ({placeholders})")
            params.extend(codes)

    if rarity:
        filters.append("rarity = %s")
        params.append(rarity.lower())

    if color:
        filters.append("color_identity ILIKE %s")
        params.append(f"%{color.upper()}%")

    if in_stock is not None:
        # Must consult stock_delta because apply_delta() runs AFTER the SQL query.
        # Without this, cards that went 0→N via an import (delta) are invisible when
        # filtering in_stock=true, and wrongly visible when filtering in_stock=false.
        if in_stock:
            filters.append(
                "(in_stock = true OR EXISTS ("
                "  SELECT 1 FROM bronze.stock_delta sd"
                "  WHERE sd.reference = gold_cards.reference"
                "    AND sd.condition = gold_cards.condition"
                "    AND sd.stock_a > 0))"
            )
        else:
            filters.append(
                "(in_stock = false AND NOT EXISTS ("
                "  SELECT 1 FROM bronze.stock_delta sd"
                "  WHERE sd.reference = gold_cards.reference"
                "    AND sd.condition = gold_cards.condition"
                "    AND sd.stock_a > 0))"
            )
        # No %s param — values are SQL literals

    if foil is not None:
        filters.append("is_foil = %s")
        params.append(foil)

    if type_line:
        filters.append("type_line ILIKE %s")
        params.append(f"%{type_line}%")

    if oracle_text:
        filters.append("oracle_text ILIKE %s")
        params.append(f"%{oracle_text}%")

    if min_cmc is not None:
        filters.append("cmc >= %s")
        params.append(min_cmc)

    if max_cmc is not None:
        filters.append("cmc <= %s")
        params.append(max_cmc)

    # Price filters go into SQL so COUNT(*) and pagination are correct.
    # sell_price_sek is a pre-computed column in gold_cards.
    if min_price is not None:
        filters.append("sell_price_sek >= %s")
        params.append(min_price)

    if max_price is not None:
        filters.append("sell_price_sek <= %s")
        params.append(max_price)

    where = ("WHERE " + " AND ".join(filters)) if filters else ""

    offset = (page - 1) * page_size

    # Single query: window function returns total alongside each row,
    # eliminating the separate COUNT(*) round-trip.
    params_paged = params + [page_size, offset]
    sql = f"""
        SELECT
            scryfall_id,
            cardmarket_id,
            name,
            set_code,
            set_name,
            collector_number,
            rarity,
            type_line,
            oracle_text,
            mana_cost,
            cmc,
            colors,
            color_identity,
            artist,
            image_url_normal,
            image_url_small,
            image_url_back,
            released_at,
            foil,
            nonfoil,
            full_art,
            promo,
            is_foil,
            in_stock,
            total_stock,
            stock_a,
            stock_b,
            stock_c,
            price_avg_sek,
            price_trend_sek,
            price_avg_foil_sek,
            price_trend_foil_sek,
            sell_price_sek,
            sell_price_foil_sek,
            price_avg_eur,
            price_low_eur,
            price_trend_eur,
            price_trend_foil_eur,
            price_date,
            eur_sek_rate,
            reference,
            condition,
            condition_discount,
            language,
            special_foil_type,
            damaged,
            price_wt,
            reduction_percent,
            reduction_start,
            reduction_end,
            sold_total,
            sold_last_year,
            special_print,
            is_signed,
            data_quality,
            match_type,
            COUNT(*) OVER() AS _total
        FROM gold.gold_cards
        {where}
        ORDER BY name, set_code, collector_number
        LIMIT %s OFFSET %s
    """
    cards = fetchall(sql, params_paged)
    total = cards[0]["_total"] if cards else 0
    for card in cards:
        del card["_total"]
    cards = apply_delta(cards)

    # Append newly created cards not yet in gold_cards.
    # Skip when in_stock=False — delta-new cards always have stock > 0.
    if in_stock is not False:
        new_cards = fetch_delta_new_cards(
            name_filter=name,
            set_filter=[c.strip().lower() for c in set_code.split(",") if c.strip()] if set_code else None,
            foil_filter=foil,
            rarity_filter=rarity,
            color_filter=color,
            type_line_filter=type_line,
            oracle_text_filter=oracle_text,
            min_cmc=min_cmc,
            max_cmc=max_cmc,
            min_price=min_price,
            max_price=max_price,
        )
        cards = cards + new_cards
        total += len(new_cards)

        # Append corrected cards not yet reflected in gold_cards.
        corrected = fetch_corrected_cards(
            name_filter=name,
            set_filter=[c.strip().lower() for c in set_code.split(",") if c.strip()] if set_code else None,
            foil_filter=foil,
            rarity_filter=rarity,
            color_filter=color,
            type_line_filter=type_line,
            oracle_text_filter=oracle_text,
            min_cmc=min_cmc,
            max_cmc=max_cmc,
        )
        cards = cards + corrected
        total += len(corrected)

    # Recalculate sell prices dynamically from pricing_ranges + sell_condition rules
    pricing = _load_pricing()
    ranges = pricing.get("ranges", [])
    sell_cond = pricing.get("rules", {}).get("sell_condition", {})
    sell_min  = pricing.get("rules", {}).get("sell_minimum", {})
    # Token floor: tokens (set_code starts with 't') that have no Scryfall price
    # get the common/uncommon minimum (5 SEK) so they always show a sell price.
    _token_min = 5.0
    if sell_min:
        rule = sell_min.get("min_common_uncommon", {})
        if rule and rule.get("is_active", True):
            _token_min = float(rule["value"])

    for card in cards:
        base = _calc_sell_price(
            card.get("price_trend_eur"), card.get("eur_sek_rate"),
            ranges, card.get("rarity", "common"),
            sold_last_year=card.get("sold_last_year"), sell_minimums=sell_min
        )
        if base is None and (card.get("set_code") or "").startswith("t"):
            base = _token_min
        card["sell_price_sek"] = _apply_sell_condition_discount(base, card.get("condition"), sell_cond)
        base_foil = _calc_sell_price(
            card.get("price_trend_foil_eur") or card.get("price_trend_eur"),
            card.get("eur_sek_rate"), ranges, card.get("rarity", "common"),
            sold_last_year=card.get("sold_last_year"), sell_minimums=sell_min
        )
        if base_foil is None and (card.get("set_code") or "").startswith("t"):
            base_foil = _token_min
        card["sell_price_foil_sek"] = _apply_sell_condition_discount(base_foil, card.get("condition"), sell_cond)

    # Apply manual price overrides.
    _overrides = _get_price_overrides()
    if _overrides:
        for card in cards:
            sc  = (card.get("set_code") or "").lower()
            cn  = card.get("collector_number") or ""
            key_nf = (sc, cn, False)
            key_f  = (sc, cn, True)
            if key_nf in _overrides:
                card["sell_price_sek"] = _overrides[key_nf]
            if key_f in _overrides:
                card["sell_price_foil_sek"] = _overrides[key_f]


    # Price filters are applied in SQL (sell_price_sek column in gold_cards).
    # After dynamic repricing, re-apply in memory so repriced cards respect the bounds.
    if min_price is not None:
        cards = [c for c in cards if c.get("sell_price_sek") and c["sell_price_sek"] >= min_price]
    if max_price is not None:
        cards = [c for c in cards if c.get("sell_price_sek") and c["sell_price_sek"] <= max_price]

    return {
        "total":     total,
        "page":      page,
        "page_size": page_size,
        "pages":     -(-total // page_size),  # ceiling division
        "cards":     cards
    }


@app.get("/cards/{scryfall_id}")
def get_card(scryfall_id: str):
    sql = """
        SELECT *
        FROM gold.gold_cards
        WHERE scryfall_id = %s
    """
    card = fetchone(sql, [scryfall_id])
    if not card:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Card not found")
    return card


# Set group classification based on set code patterns
def classify_set_group(set_code: str) -> str:
    if not set_code:
        return "Other"
    s = set_code.lower()
    # Promos and special
    if s in ('fnm','dci','jr','j19','j20','pj21','p22','p23','mpr','pgpx','pcmp',
             'pwor','gdy','pal','wcd00','wcd01','wcd02','wcd03','wcd04',
             'ppro','pwpn','pppr','plg20','plg21','peld','pznr','pkhm',
             'pthb','pstx','pmid','pvow','pneo','psnc','pdmu','pbro','pmom',
             'pmul','pwoe','plci','pmkm','potj','pdsk'):
        return "Promos"
    if s.startswith('p') and len(s) in (4,5):
        return "Promos"
    # Secret Lair
    if s.startswith('sl') or s in ('slx',):
        return "Secret Lair"
    # Commander
    if s in ('cmd','c13','c14','c15','c16','c17','c18','c19','c20','c21',
             'cmr','afc','nec','clb','dmc','ltd','onc','mul','woc','clu',
             'cmm','lcc','moc','otc','fdc','blc','dsc','fic'):
        return "Commander"
    if s.endswith('c') and len(s) >= 4:
        return "Commander"
    # Masters / Reprint sets
    if s in ('mma','mm2','mm3','ema','ima','a25','uma','2xm','2x2',
             'tsr','akr','klr','j21','mb1','mb2','cmb1','cmb2','plst',
             'rvr','ltr','who','acr'):
        return "Masters & Reprint"
    # Funny / Un-sets
    if s in ('ust','unh','ugl','unf','und','hho','h17','h1r','plist'):
        return "Special / Un-sets"
    # Classic (pre-8th Edition, pre-2003)
    classic = {'lea','leb','2ed','3ed','4ed','5ed','6ed','7ed',
               'arn','atq','leg','drk','fem','ice','all','hml',
               'mir','vis','wth','tmp','sth','exo','usg','ulg','uds',
               'mmq','nem','pcy','inv','pls','apc','ody','tor','jud',
               'ons','lgn','scg','8ed','mrd','dst','5dn','chk','bok',
               'sok','rav','gpt','dis','csp','tsp','plc','fut',
               '2ed','fbb','4bb','sum','ren','rin'}
    if s in classic:
        return "Classic (pre-2004)"
    # By rough era using released_at — fallback by set code length/pattern heuristics
    # Modern era sets tend to have 3-letter codes matching known blocks
    modern_era = {'10e','lrw','mor','shm','eve','ala','con','arb','zen',
                  'wwk','roe','m10','m11','m12','m13','m14','m15',
                  'som','mbs','nph','isd','dka','avr','rtr','gtc',
                  'dgm','ths','bng','jou','ktk','frf','dtk',
                  'bfz','ogw','soi','emn','kld','aer','akh','hou',
                  'xln','rix','dom','m19','grn','rna','war','m20',
                  'eld','thb','iko','m21','znr','khm','stx','mh1','mh2',
                  'afr','mid','vow','neo','snc','dmu','bro','one',
                  'mom','mat','woe','lci','mkm','otj','blb','dsk',
                  'fdn','mh3','acr','dft','eoe','fin','inr'}
    if s in modern_era:
        return "Modern Sets"
    return "Other"


@app.get("/sets")
def get_sets():
    sql = """
        SELECT DISTINCT set_code, set_name
        FROM gold.gold_cards
        WHERE set_code IS NOT NULL
        ORDER BY set_name
    """
    rows = fetchall(sql)
    # Add set_group classification
    for row in rows:
        row["set_group"] = classify_set_group(row["set_code"])
    return rows


@app.get("/sets/{set_code}/cards")
def get_cards_by_set(
    set_code:  str,
    in_stock:  Optional[bool] = Query(None),
    page:      int            = Query(1, ge=1),
    page_size: int            = Query(20, ge=1, le=100),
):
    filters = ["set_code ILIKE %s"]
    params  = [set_code]

    if in_stock is not None:
        if in_stock:
            filters.append(
                "(in_stock = true OR EXISTS ("
                "  SELECT 1 FROM bronze.stock_delta sd"
                "  WHERE sd.reference = gold_cards.reference"
                "    AND sd.condition = gold_cards.condition"
                "    AND sd.stock_a > 0))"
            )
        else:
            filters.append(
                "(in_stock = false AND NOT EXISTS ("
                "  SELECT 1 FROM bronze.stock_delta sd"
                "  WHERE sd.reference = gold_cards.reference"
                "    AND sd.condition = gold_cards.condition"
                "    AND sd.stock_a > 0))"
            )

    where  = "WHERE " + " AND ".join(filters)
    offset = (page - 1) * page_size

    total = fetchone(f"SELECT COUNT(*) as total FROM gold.gold_cards {where}", params)["total"]

    sql = f"""
        SELECT
            scryfall_id, name, set_code, set_name, collector_number,
            rarity, type_line, mana_cost, image_url_normal, image_url_small,
            in_stock, total_stock, is_foil,
            price_avg_sek, price_trend_sek, price_avg_foil_sek, price_trend_foil_sek
        FROM gold.gold_cards
        {where}
        ORDER BY collector_number::integer
        LIMIT %s OFFSET %s
    """
    cards = fetchall(sql, params + [page_size, offset])

    return {
        "total":    total,
        "page":     page,
        "pages":    -(-total // page_size),
        "set_code": set_code.upper(),
        "cards":    cards
    }


@app.get("/stats")
def get_stats():
    sql = """
        SELECT
            COUNT(*)                                         AS total_cards,
            COUNT(CASE WHEN in_stock  THEN 1 END)           AS cards_in_stock,
            SUM(total_stock)                                 AS total_units,
            COUNT(CASE WHEN price_avg_sek IS NOT NULL
                        THEN 1 END)                         AS cards_with_price,
            COUNT(DISTINCT set_code)                         AS total_sets
        FROM gold.gold_cards
    """
    return fetchone(sql)

    # ============================================================
#  ADD TO api.py — Manabox CSV Import Endpoints
#  Paste this block after the existing imports and before the
#  existing endpoints. Also add to imports at top of api.py:
#
#  import csv, io
#  import mysql.connector
#  from fastapi import UploadFile, File
# ============================================================

# MySQL connection config — LGS DB



# MANABOX_TO_ALPHASPEL_CONDITION is defined near the top of this file.

def _apply_stock_delta_to_import(cur, import_id: int):
    """
    After the matching cascade, add any pending stock_delta amounts to
    current_stock_a and new_stock_value so the preview and verify show
    live stock (silver_stock + today's earlier imports).
    """
    cur.execute("""
        UPDATE bronze.manabox_import_rows r
        SET current_stock_a = r.current_stock_a + sd.stock_a,
            new_stock_value  = r.new_stock_value  + sd.stock_a
        FROM bronze.stock_delta sd
        WHERE sd.reference = r.matched_reference
          AND sd.condition  = r.alphaspel_condition
          AND r.import_id   = %s
          AND r.match_status IN ('matched', 'zero_stock', 'condition_mismatch')
          AND sd.stock_a > 0
    """, (import_id,))


# Five-tier matching cascade — shared by CSV import and trade-in import.
# Each SQL expects a single %s parameter: import_id.
MATCHING_TIERS = [
    ("exact_printing", """
        UPDATE bronze.manabox_import_rows r
        SET matched_reference = ss.reference,
            matched_name      = ss.name,
            matched_set_code  = ss.set_code,
            current_stock_a   = ss.stock_a,
            current_stock_b   = ss.stock_b,
            current_stock_c   = ss.stock_c,
            target_stock_col  = CASE WHEN ss.stock_b > 0 THEN 'stock_b'
                                     WHEN ss.stock_c > 0 THEN 'stock_c'
                                     ELSE 'stock_a' END,
            new_stock_value   = CASE WHEN ss.stock_b > 0 THEN ss.stock_b + r.quantity
                                     WHEN ss.stock_c > 0 THEN ss.stock_c + r.quantity
                                     ELSE ss.stock_a + r.quantity END,
            delta             = r.quantity,
            match_status      = 'matched',
            match_tier        = 'exact_printing'
        FROM silver.silver_stock ss
        WHERE ss.scryfall_id = r.scryfall_id
          AND coalesce(ss.is_foil, false) = (r.foil = 'foil')
          AND ss.condition = r.alphaspel_condition
          AND r.import_id = %s
    """),
    ("exact_printing_wrong_condition", """
        UPDATE bronze.manabox_import_rows r
        SET matched_reference = ss.reference,
            matched_name      = ss.name,
            matched_set_code  = ss.set_code,
            current_stock_a   = ss.stock_a,
            current_stock_b   = ss.stock_b,
            current_stock_c   = ss.stock_c,
            target_stock_col  = 'stock_a',
            new_stock_value   = r.quantity,
            delta             = r.quantity,
            match_status      = 'condition_mismatch',
            match_tier        = 'exact_printing_wrong_condition'
        FROM silver.silver_stock ss
        WHERE ss.scryfall_id = r.scryfall_id
          AND coalesce(ss.is_foil, false) = (r.foil = 'foil')
          AND r.import_id = %s AND r.match_status IS NULL
    """),
    ("csv_reference_lookup", """
        UPDATE bronze.manabox_import_rows r
        SET matched_reference =
                CASE
                    WHEN sc.set_code ~ '^p[a-z]'
                         AND sc.collector_number ~ '[0-9]p$'
                    THEN upper(substr(sc.set_code, 2)) || '-' ||
                         lpad(regexp_replace(sc.collector_number, 'p$', ''), 3, '0') || 'PF'
                    WHEN sc.collector_number ~ '^[0-9]+$'
                    THEN upper(sc.set_code) || '-' || lpad(sc.collector_number, 3, '0')
                    ELSE upper(sc.set_code) || '-' || upper(sc.collector_number)
                END,
            matched_name      = sc.name,
            matched_set_code  = sc.set_code,
            current_stock_a   = 0, current_stock_b = 0, current_stock_c = 0,
            target_stock_col  = 'stock_a',
            new_stock_value   = r.quantity,
            delta             = r.quantity,
            match_status      = 'zero_stock',
            match_tier        = 'csv_reference_lookup'
        FROM silver.silver_cards sc
        WHERE sc.scryfall_id = r.scryfall_id
          AND r.import_id = %s AND r.match_status IS NULL
    """),
    ("scryfall_zero_stock", """
        UPDATE bronze.manabox_import_rows r
        SET matched_reference =
                CASE
                    WHEN sc.set_code ~ '^p[a-z]'
                         AND sc.collector_number ~ '[0-9]p$'
                    THEN upper(substr(sc.set_code, 2)) || '-' ||
                         lpad(regexp_replace(sc.collector_number, 'p$', ''), 3, '0') || 'PF'
                    WHEN sc.collector_number ~ '^[0-9]+$'
                    THEN upper(sc.set_code) || '-' || lpad(sc.collector_number, 3, '0')
                    ELSE upper(sc.set_code) || '-' || upper(sc.collector_number)
                END,
            matched_name      = sc.name,
            matched_set_code  = sc.set_code,
            current_stock_a   = 0, current_stock_b = 0, current_stock_c = 0,
            target_stock_col  = 'stock_a',
            new_stock_value   = r.quantity,
            delta             = r.quantity,
            match_status      = 'zero_stock',
            match_tier        = 'scryfall_zero_stock'
        FROM silver.silver_cards sc
        WHERE sc.scryfall_id = r.scryfall_id
          AND r.import_id = %s AND r.match_status IS NULL
    """),
    ("scryfall_name_zero_stock", """
        UPDATE bronze.manabox_import_rows r
        SET matched_reference =
                CASE
                    WHEN sc.set_code ~ '^p[a-z]'
                         AND sc.collector_number ~ '[0-9]p$'
                    THEN upper(substr(sc.set_code, 2)) || '-' ||
                         lpad(regexp_replace(sc.collector_number, 'p$', ''), 3, '0') || 'PF'
                    WHEN sc.collector_number ~ '^[0-9]+$'
                    THEN upper(sc.set_code) || '-' || lpad(sc.collector_number, 3, '0')
                    ELSE upper(sc.set_code) || '-' || upper(sc.collector_number)
                END,
            matched_name      = sc.name,
            matched_set_code  = sc.set_code,
            current_stock_a   = 0, current_stock_b = 0, current_stock_c = 0,
            target_stock_col  = 'stock_a',
            new_stock_value   = r.quantity,
            delta             = r.quantity,
            match_status      = 'zero_stock',
            match_tier        = 'scryfall_name_zero_stock'
        FROM silver.silver_cards sc
        WHERE upper(sc.name) = upper(r.name)
          AND r.import_id = %s AND r.match_status IS NULL
          AND sc.scryfall_id = (
              SELECT sc2.scryfall_id FROM silver.silver_cards sc2
              WHERE upper(sc2.name) = upper(r.name)
              ORDER BY sc2.released_at DESC NULLS LAST LIMIT 1
          )
    """),
]

# ------------------------------------------------------------
#  POST /import/upload
# ------------------------------------------------------------

# ============================================================
#  MANABOX CSV IMPORT ENDPOINTS
# ============================================================

@app.post("/import/upload")
async def upload_import(file: UploadFile = File(...), force: bool = False):
    content_bytes = await file.read()
    text          = content_bytes.decode("utf-8-sig")
    file_hash     = hashlib.md5(content_bytes).hexdigest()

    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # ── Duplicate check ───────────────────────────────────────
    cur.execute(
        "SELECT import_id, status, uploaded_at FROM bronze.manabox_imports"
        " WHERE file_hash = %s AND status NOT IN ('cancelled', 'pending')",
        (file_hash,)
    )
    existing = cur.fetchone()
    if existing and not force:
        cur.close(); conn.close()
        raise HTTPException(
            status_code=409,
            detail=f"This file was already imported (import #{existing['import_id']}, "
                   f"status: {existing['status']}). "
                   f"Use force=true to re-import, or cancel that import first."
        )
    if existing and force:
        # Cancel the existing import so we can re-upload
        cur.execute(
            "UPDATE bronze.manabox_imports SET status='cancelled' WHERE import_id=%s",
            (existing["import_id"],)
        )
        conn.commit()

    # Clean up any stale pending/cancelled imports for this file
    cur.execute(
        "DELETE FROM bronze.manabox_import_rows WHERE import_id IN "
        "(SELECT import_id FROM bronze.manabox_imports WHERE file_hash = %s AND status IN ('pending','cancelled'))",
        (file_hash,)
    )
    cur.execute(
        "DELETE FROM bronze.manabox_imports WHERE file_hash = %s AND status IN ('pending','cancelled')",
        (file_hash,)
    )
    conn.commit()

    # ── Parse CSV ────────────────────────────────────────────
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for r in reader:
        mc = r.get("Condition", "near_mint").strip().lower()
        ac = MANABOX_TO_ALPHASPEL_CONDITION.get(mc, "NM")
        rows.append({
            "name":             r.get("Name","").strip(),
            "set_code":         r.get("Set code","").strip(),
            "set_name":         r.get("Set name","").strip(),
            "collector_number": r.get("Collector number","").strip(),
            "foil":             r.get("Foil","normal").strip().lower(),
            "rarity":           r.get("Rarity","common").strip().lower(),
            "quantity":         int(r.get("Quantity",1) or 1),
            "manabox_id":       r.get("ManaBox ID","").strip(),
            "scryfall_id":      r.get("Scryfall ID","").strip(),
            "purchase_price":   r.get("Purchase price","0").strip() or "0",
            "manabox_condition":mc,
            "alphaspel_condition":ac,
            "language":         r.get("Language","en").strip(),
        })

    if not rows:
        cur.close(); conn.close()
        raise HTTPException(status_code=400, detail="CSV file is empty or could not be parsed")

    # ── Create import batch ───────────────────────────────────
    cur.execute(
        "INSERT INTO bronze.manabox_imports (filename, file_hash, row_count, status)"
        " VALUES (%s, %s, %s, 'previewed') RETURNING import_id",
        (file.filename, file_hash, len(rows))
    )
    import_id = cur.fetchone()["import_id"]

    # ── Stage rows ────────────────────────────────────────────
    for r in rows:
        cur.execute(
            "INSERT INTO bronze.manabox_import_rows"
            " (import_id,name,set_code,set_name,collector_number,foil,rarity,"
            "  quantity,manabox_id,scryfall_id,purchase_price,manabox_condition,"
            "  alphaspel_condition,language)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (import_id, r["name"], r["set_code"], r["set_name"], r["collector_number"],
             r["foil"], r["rarity"], r["quantity"], r["manabox_id"], r["scryfall_id"],
             r["purchase_price"], r["manabox_condition"], r["alphaspel_condition"], r["language"])
        )
    conn.commit()

    # ── Run matching cascade ─────────────────────────────────
    # Each tier runs in its own savepoint so a SQL error in one
    # tier doesn't abort the whole transaction.
    tier_errors = []

    for tier_name, sql in MATCHING_TIERS:
        try:
            cur.execute("SAVEPOINT tier_match")
            cur.execute(sql, (import_id,))
            cur.execute("RELEASE SAVEPOINT tier_match")
        except Exception as _e:
            cur.execute("ROLLBACK TO SAVEPOINT tier_match")
            tier_errors.append(f"{tier_name}: {_e}")


    # Unmatched
    cur.execute("""
        UPDATE bronze.manabox_import_rows
        SET match_status = 'not_in_alphaspel', match_tier = 'no_match'
        WHERE import_id = %s AND match_status IS NULL
    """, (import_id,))

    _apply_stock_delta_to_import(cur, import_id)

    cur.execute("""
        UPDATE bronze.manabox_imports SET
            matched_count = (SELECT COUNT(*) FROM bronze.manabox_import_rows
                             WHERE import_id = %s AND match_status IN ('matched','zero_stock')),
            applied_count = 0
        WHERE import_id = %s
    """, (import_id, import_id))

    conn.commit()
    cur.close()
    conn.close()
    preview = _build_preview(import_id)
    preview["tier_errors"] = []  # tier_errors only available at upload time
    return preview


@app.get("/import/{import_id}/preview")
def get_import_preview(import_id: int):
    preview = _build_preview(import_id)
    preview["tier_errors"] = []  # tier_errors only available at upload time
    return preview


def _create_catalog_product(mysql_cur, source_ref: str, foil_ref: str, condition: str, quantity: int, override_name=None) -> tuple[bool, str, str]:
    """
    Create a new catalog_product row in the LGS MySQL database.
    Used when a card variant (foil, promo, condition) does not yet exist in the catalog.
    Returns (success, action, error_message).
    """
    import re
    from datetime import datetime

    # Safety check: only block if the EXACT target ref already exists.
    # Legacy format (CMA-111F) and new format (CMA-111-F) can coexist.
    mysql_cur.execute(
        "SELECT reference FROM catalog_product"
        " WHERE REGEXP_REPLACE(reference, %s, %s) = %s LIMIT 1",
        ("^[#!$]+", "", foil_ref)
    )
    _existing = mysql_cur.fetchone()
    try: mysql_cur.fetchall()
    except: pass
    if _existing:
        return False, "exists", _existing[0]

    # ── Derive name and slug ──────────────────────────────────────────
    is_foil = foil_ref.endswith("-F")

    # Card name: use override_name if given, else derive from foil_ref
    # foil_ref looks like "LTR-095-F" or "C16-042-F" or "ICE-270-NM"
    if override_name:
        card_name = override_name
    else:
        card_name = foil_ref  # fallback — will be ugly but won't crash

    set_part = foil_ref.split("-")[0]  # e.g. "LTR", "C16"

    if override_name:
        # override_name already contains "Magic löskort: SET: CardName" — just add Foil suffix
        full_name = f"{card_name} (Foil)" if is_foil else card_name
    elif is_foil:
        full_name = f"Magic löskort: {card_name} (Foil)"
    else:
        full_name = f"Magic löskort: {card_name}"

    # Build slug: Swedish char normalization + lowercase + hyphens
    _slug = full_name
    for _old, _new in [("å","a"),("ä","a"),("ö","o"),("Å","a"),("Ä","a"),("Ö","o")]:
        _slug = _slug.replace(_old, _new)
    slug_base = re.sub(r"[^a-z0-9]+", "-", _slug.lower()).strip("-")
    slug = f"{slug_base}-{foil_ref.lower()}"

    # ── Category + template fields: look up from same set ────────────
    mysql_cur.execute(
        "SELECT category_id, manufacturer_id, bitflags, product_type_id FROM catalog_product"
        " WHERE reference LIKE %s AND type IN ('game','used_game')"
        "   AND category_id IS NOT NULL LIMIT 1",
        (f"{set_part}-%",)
    )
    cat_row = mysql_cur.fetchone()
    try: mysql_cur.fetchall()
    except: pass
    if not cat_row:
        # Set not yet in catalog — fall back to any valid active MTG game row
        mysql_cur.execute(
            "SELECT category_id, manufacturer_id, bitflags, product_type_id FROM catalog_product"
            " WHERE type IN ('game','used_game') AND category_id IS NOT NULL"
            "   AND is_active = 1 LIMIT 1"
        )
        cat_row = mysql_cur.fetchone()
        try: mysql_cur.fetchall()
        except: pass
    category_id     = cat_row[0] if cat_row else None
    manufacturer_id = cat_row[1] if cat_row else None
    bitflags        = cat_row[2] if cat_row else 1
    product_type_id = cat_row[3] if cat_row else None

    # ── Pricing: use silver_cards data if available, else 15 SEK ────
    # (sell price will be calculated properly by dbt on next pipeline run)
    price = 15.00

    # ── Build INSERT with hardcoded safe values ───────────────────────
    now = datetime.now()
    mysql_cur.execute("""
        INSERT INTO catalog_product (
            price_wt, price_wot, wholesale_price, tax_rate,
            name, slug, is_active,
            stock_a, stock_b, stock_c,
            sold_total, sold_last_year, popularity,
            reference, `condition`,
            created_at, updated_at, `new`,
            category_id, prisjakt,
            type, reduction_percent,
            long_description,
            damaged, bitflags, barcode, isbn, location,
            description, notes, on_order_text, out_of_stock_text,
            endofsale, on_order, bulky, dangerous_goods, tradein,
            tradein_percent, not_abroad, pickuponly, infinite_stock,
            available, desired_quantity, reduction_amount,
            upcoming, upcoming_text, used, age, max_players, min_players,
            playing_time, bgg_number, max_backorder, max_order_per_customer,
            max_stock_display, product_type_id, manufacturer_id,
            manufacturer_reference
        ) VALUES (
            %s, %s, %s, 0.000,
            %s, %s, 1,
            %s, 0, 0,
            0, 0, 0,
            %s, %s,
            %s, %s, NOW(),
            %s, 0,
            'used_game', 0,
            '',
            0, %s, '', '', '',
            %s, '', '', '',
            0, 0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0.00,
            0, '', 1, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL,
            NULL, %s, %s,
            NULL
        )
    """, (
        price,                    # price_wt
        price,                    # price_wot
        round(price * (_load_pricing().get("rules",{}).get("internal",{}).get("wholesale_pct",{"value":50})["value"] / 100), 2),  # wholesale_price
        full_name,                # name
        slug,                     # slug
        quantity,                 # stock_a
        foil_ref,                 # reference
        condition,                # condition
        now,                      # created_at
        now,                      # updated_at
        category_id,              # category_id
        bitflags,                 # bitflags
        "Löskort till Magic the Gathering. Skick i minst NM om inget annat är angivet.",  # description
        product_type_id,          # product_type_id
        manufacturer_id,          # manufacturer_id
    ))

    return True, "inserted", None


def get_import_preview(import_id: int):
    return _build_preview(import_id)


def _build_preview(import_id: int):
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM bronze.manabox_imports WHERE import_id = %s", (import_id,))
    batch = cur.fetchone()
    if not batch:
        raise HTTPException(status_code=404, detail="Import not found")
    cur.execute("""
        SELECT r.row_id, r.name, r.set_code, r.set_name, r.collector_number, r.foil,
               r.manabox_condition, r.alphaspel_condition, r.quantity, r.scryfall_id,
               r.matched_reference, r.matched_name, r.matched_set_code,
               r.match_status, r.match_tier,
               r.current_stock_a, r.current_stock_b, r.current_stock_c,
               r.target_stock_col, r.new_stock_value, r.delta,
               r.applied_at, r.applied_reference, r.apply_action, r.apply_error,
               CASE WHEN r.foil = 'foil' THEN sc.sell_price_foil_sek
                    ELSE sc.sell_price_sek END AS sell_price_sek,
               sc.image_url_small
        FROM bronze.manabox_import_rows r
        LEFT JOIN silver.silver_cards sc ON sc.scryfall_id = r.scryfall_id
        WHERE r.import_id = %s
        ORDER BY CASE match_status
            WHEN 'matched'             THEN 1
            WHEN 'zero_stock'          THEN 2
            WHEN 'condition_mismatch'  THEN 3
            ELSE 4 END, name
    """, (import_id,))
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return {
        "import_id":     import_id,
        "filename":      batch["filename"],
        "uploaded_at":   str(batch["uploaded_at"]),
        "status":        batch["status"],
        "row_count":     batch["row_count"],
        "matched_count": batch["matched_count"],
        "applied_count": batch.get("applied_count", 0),
        "rows":          rows,
    }



def _fetchone(cur, sql, params=()):
    cur.execute(sql, params)
    row = cur.fetchone()
    try: cur.fetchall()  # drain any remaining rows
    except: pass
    return row

def _execute(cur, sql, params=()):
    cur.execute(sql, params)

import threading as _threading

def _run_confirm_background(import_id: int):
    """Run the confirm loop in a background thread."""
    import traceback, logging
    try:
        confirm_import(import_id)
    except Exception as e:
        logging.error(f"[confirm_background] import_id={import_id} FAILED: {e}\n{traceback.format_exc()}")
        # Reset to pending on failure so operator can retry
        try:
            conn = get_conn()
            cur  = conn.cursor()
            cur.execute(
                "UPDATE bronze.manabox_imports SET status='pending' WHERE import_id=%s",
                (import_id,)
            )
            conn.commit(); cur.close(); conn.close()
        except Exception:
            pass


@app.post("/import/{import_id}/confirm")
def confirm_import(import_id: int):
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Guard: only block if already fully confirmed
    cur.execute("SELECT status FROM bronze.manabox_imports WHERE import_id = %s", (import_id,))
    batch = cur.fetchone()
    if not batch:
        raise HTTPException(status_code=404, detail="Import not found")
    if batch["status"] == "confirmed":
        raise HTTPException(status_code=409, detail="Import already confirmed")
    # Mark as confirming so UI knows it's in progress
    cur.execute(
        "UPDATE bronze.manabox_imports SET status = 'confirming' WHERE import_id = %s",
        (import_id,)
    )
    conn.commit()

    cur.execute("""
        SELECT r.row_id, r.matched_reference, r.target_stock_col, r.new_stock_value,
               r.alphaspel_condition, r.manabox_condition, r.match_status, r.foil, r.name, r.delta,
               coalesce(sc.set_name, '') as scryfall_set_name
        FROM bronze.manabox_import_rows r
        LEFT JOIN silver.silver_cards sc ON sc.scryfall_id = r.scryfall_id
        WHERE import_id = %s
          AND match_status IN ('matched', 'zero_stock', 'condition_mismatch')
          AND delta > 0
          AND matched_reference IS NOT NULL
    """, (import_id,))
    rows = [dict(r) for r in cur.fetchall()]

    if not rows:
        # Nothing matched (e.g. new set not yet in silver_cards) — complete gracefully
        cur.execute("""
            UPDATE bronze.manabox_imports
            SET status = 'confirmed', confirmed_at = now(), applied_count = 0
            WHERE import_id = %s
        """, (import_id,))
        conn.commit()
        cur.close(); conn.close()
        return {"import_id": import_id, "status": "confirmed", "applied_count": 0, "message": "No matching rows found — 0 cards applied."}

    mysql_conn = get_mysql_conn()
    mysql_cur = mysql_conn.cursor()
    applied = 0

    # ── Pre-fetch all relevant MySQL rows in ONE batch query ──────────────
    import re as _re_pre

    def _build_target_ref_pre(ref, is_foil, match_status, condition):
        base = _re_pre.sub(r'-F$', '', ref or '')
        base = _re_pre.sub(r'([0-9])([A-Z]+)$', r'\1', base)
        if match_status == 'condition_mismatch':
            return (base + '-F-' + condition) if is_foil else (base + '-' + condition)
        return (base + '-F') if is_foil else base

    _all_target_refs = []
    for _r in rows:
        _is_foil = _r['foil'] == 'foil'
        _t = _build_target_ref_pre(
            _r['matched_reference'] or '',
            _is_foil,
            _r['match_status'] or '',
            _r['alphaspel_condition'] or 'NM'
        )
        _all_target_refs.append(_t)
        if _t.endswith('-F'):
            _all_target_refs.append(_t[:-2] + 'F')  # legacy foil variant

    _all_target_refs = list(set(r for r in _all_target_refs if r))
    if _all_target_refs:
        _rx = '^[#!$]+'
        _ph = ','.join(['%s'] * len(_all_target_refs))
        mysql_cur.execute(
            f'SELECT id, REGEXP_REPLACE(reference,%s,%s) AS clean_ref,'
            f'       reference, stock_a, `condition`, is_active, prisjakt'
            f' FROM catalog_product'
            f' WHERE REGEXP_REPLACE(reference,%s,%s) IN ({_ph})'
            f' ORDER BY is_active DESC, id DESC',
            [_rx, '', _rx, ''] + _all_target_refs
        )
        _prefetch = {}
        for _pr in mysql_cur.fetchall():
            _pid, _pclean, _pref, _pstock, _pcond, _pactive, _pprisjakt = _pr
            if _pclean not in _prefetch:
                _prefetch[_pclean] = {
                    'id': _pid, 'reference': _pref, 'stock_a': _pstock,
                    'condition': _pcond, 'is_active': _pactive, 'prisjakt': _pprisjakt
                }
    else:
        _prefetch = {}
    # ─────────────────────────────────────────────────────────────────────

    # Process non-foil rows first so foil copies have templates available
    rows = sorted(rows, key=lambda r: (1 if r["foil"] == "foil" else 0))

    for r in rows:
        row_id     = r["row_id"]
        ref        = r["matched_reference"]
        col        = r["target_stock_col"]
        new_val    = r["new_stock_value"]
        condition  = r["alphaspel_condition"]
        is_foil    = (r["foil"] == "foil")
        is_damaged = (r.get("manabox_condition") or "").lower() == "damaged"
        # Build target reference
        # Foil:               MOM-065     -> MOM-065-F
        # Condition mismatch: ICE-312     -> ICE-312-EX  (new row for correct condition)
        # Normalize ref: strip legacy foil suffix (HOU-057F -> HOU-057)
        # A ref is "legacy foil" if it ends with a letter that isn't after a dash
        # and has digits before that letter (e.g. HOU-057F, V13-007F, CMA-111F)
        import re as _re
        # Strip trailing uppercase letters after digits (e.g. HOU-057F -> HOU-057)
        # Also strip -F suffix (e.g. CMA-111-F -> CMA-111, V13-007-F -> V13-007)
        _base_ref = _re.sub(r'-F$', '', ref)           # strip -F suffix first
        _base_ref = _re.sub(r'([0-9])([A-Z]+)$', r'\1', _base_ref)  # then strip legacy suffix
        _is_legacy_foil = (_base_ref != ref)  # ref had a foil suffix

        if r["match_status"] == "condition_mismatch":
            cond_suffix = condition  # e.g. NM, VF, FN, GD
            if is_foil:
                target_ref = _base_ref + "-F-" + cond_suffix
            else:
                target_ref = _base_ref + "-" + cond_suffix
        else:
            if is_foil:
                target_ref = _base_ref + "-F"
            else:
                target_ref = _base_ref

        # ── Live-stock override ──────────────────────────────────────────
        # new_stock_value was calculated from silver_stock, which only rebuilds
        # once per day. For multiple same-day imports of the same cards (e.g.
        # several trade-ins), we use the CURRENT MySQL stock from the prefetch
        # snapshot (taken at the start of this confirm run) plus our delta so
        # quantities stack correctly without a dbt run between imports.
        _legacy_foil_ref = (target_ref[:-2] + "F") if target_ref.endswith("-F") else None
        _live_pf = _prefetch.get(target_ref) or (
            _prefetch.get(_legacy_foil_ref) if _legacy_foil_ref else None
        )
        if _live_pf is not None:
            new_val = _live_pf["stock_a"] + r["delta"]
            if new_val != r["new_stock_value"]:
                # Keep stored new_stock_value in sync so verify_import agrees
                cur.execute(
                    "UPDATE bronze.manabox_import_rows SET new_stock_value = %s WHERE row_id = %s",
                    (new_val, row_id)
                )
        # If not in prefetch (truly new card, not yet in MySQL) keep new_val = delta

        action     = None
        error_msg  = None

        try:
            if is_foil:
                # Check if foil row already exists
                # Search for foil row in both formats: HOU-057-F (new) and HOU-057F (legacy)
                # Also match NULL condition (some legacy rows have no condition set)
                _legacy_ref = target_ref[:-2] + "F" if target_ref.endswith("-F") else target_ref
                # Use prefetch dict instead of querying MySQL per row
                # Prefer new format (-F) over legacy (F) when both exist
                _pf_row = _prefetch.get(target_ref) or _prefetch.get(_legacy_ref)
                if _pf_row and (_pf_row["condition"] == condition or _pf_row["condition"] is None):
                    _execute(mysql_cur,
                        f"UPDATE catalog_product SET {col}=%s, is_active=1, updated_at=NOW(), prisjakt=0,"
                        f" `condition`=COALESCE(`condition`, %s)"
                        " WHERE id=%s",  # update by id — touches exactly ONE row
                        (new_val, condition, _pf_row["id"])
                    )
                    action = "updated"
                elif _pf_row:
                    # Exists but wrong condition — treat as not found, fall through to copy
                    _pf_row = None

                if _pf_row:
                    pass  # already updated above
                else:
                    # Row doesn't exist — create new foil listing with hardcoded template
                    sn = (r.get("scryfall_set_name") or "").strip()
                    cn = r["name"]
                    _foil_name = ("Magic löskort: " + sn + ": " + cn) if sn else cn
                    ok, action, error_msg = _create_catalog_product(
                        mysql_cur, None, target_ref, condition, new_val,
                        override_name=_foil_name
                    )
                    if not ok and action == "exists":
                        # Row exists but may have wrong condition — check if it matches our condition
                        _actual_ref = error_msg
                        mysql_cur.execute(
                            "SELECT stock_a FROM catalog_product"
                            " WHERE reference=%s AND `condition`=%s LIMIT 1",
                            (_actual_ref, condition)
                        )
                        _exact = mysql_cur.fetchone()
                        try: mysql_cur.fetchall()
                        except: pass
                        if _exact:
                            # Exact match — UPDATE it
                            _execute(mysql_cur,
                                f"UPDATE catalog_product SET {col}=%s, is_active=1, updated_at=NOW(), prisjakt=0"
                                " WHERE reference=%s AND `condition`=%s",
                                (new_val, _actual_ref, condition)
                            )
                            action = "updated"
                        else:
                            # Wrong condition — INSERT as new row with correct condition
                            # Use the existing row as template but with our target_ref and condition
                            ok2, action2, err2 = _create_catalog_product(
                                mysql_cur, _actual_ref, target_ref, condition, new_val,
                                override_name=None
                            )
                            if ok2:
                                action = action2
                            elif action2 == "exists":
                                # target_ref now exists (maybe from previous run) — UPDATE it
                                _execute(mysql_cur,
                                    f"UPDATE catalog_product SET {col}=%s, is_active=1, updated_at=NOW(), prisjakt=0"
                                    " WHERE reference=%s AND `condition`=%s",
                                    (new_val, target_ref, condition)
                                )
                                action = "updated"
                            else:
                                raise Exception(f"Could not insert {target_ref}: {err2}")
                        ok = True
                        error_msg = None
                    elif not ok:
                        # Non-foil also missing — search by name for any template
                        card_name = r["name"]
                        tmpl = _fetchone(mysql_cur,
                            "SELECT reference FROM catalog_product"
                            " WHERE name LIKE %s AND `condition` = %s"
                            "   AND type IN ('game','used_game') LIMIT 1",
                            (f"%{card_name}%", condition)
                        )
                        if not tmpl:
                            tmpl = _fetchone(mysql_cur,
                                "SELECT reference FROM catalog_product"
                                " WHERE `condition` = %s AND is_active = 1"
                                "   AND type IN ('game','used_game')"
                                "   AND reference REGEXP '^[A-Z0-9]+-[0-9]+' LIMIT 1",
                                (condition,)
                            )
                        if tmpl:
                            sn = (r.get("scryfall_set_name") or "").strip()
                            cn = r["name"]
                            correct_name = ("Magic löskort: " + sn + ": " + cn) if sn else None
                            ok, action, error_msg = _create_catalog_product(mysql_cur, tmpl[0], target_ref, condition, new_val,
                                override_name=correct_name
                            )
                            if not ok and action == "exists":
                                _actual_ref = error_msg
                                _execute(mysql_cur,
                                    f"UPDATE catalog_product SET {col}=%s, is_active=1, updated_at=NOW(), prisjakt=0"
                                    " WHERE reference=%s AND `condition`=%s",
                                    (new_val, _actual_ref, condition)
                                )
                                action = "updated"
                                ok = True
                                error_msg = None
                            elif not ok:
                                raise Exception(error_msg)
                        else:
                            raise Exception(f"No template found to create {target_ref}")
            else:
                # Check if row exists in MySQL first
                _exists = _fetchone(mysql_cur,
                    "SELECT reference FROM catalog_product"
                    " WHERE REGEXP_REPLACE(reference, %s, %s) = %s AND `condition` = %s",
                    ("^[#!$]+", "", target_ref, condition)
                )
                if _exists:
                    # Update by id to avoid hitting duplicate reference+condition rows
                    _nf_id = _fetchone(mysql_cur,
                        "SELECT id FROM catalog_product"
                        " WHERE REGEXP_REPLACE(reference, %s, %s)=%s AND `condition`=%s"
                        " ORDER BY is_active DESC, id DESC LIMIT 1",
                        ("^[#!$]+", "", target_ref, condition)
                    )
                    if _nf_id:
                        _execute(mysql_cur,
                            f"UPDATE catalog_product SET {col}=%s, is_active=1, updated_at=NOW(), prisjakt=0,"
                            f" `condition`=COALESCE(`condition`, %s)"
                            " WHERE id=%s",
                            (new_val, condition, _nf_id[0])
                        )
                    action = "updated"
                else:
                    # Row doesn't exist — create it fresh with hardcoded template
                    sn = (r.get("scryfall_set_name") or "").strip()
                    cn = r["name"]
                    correct_name = ("Magic löskort: " + sn + ": " + cn) if sn else cn
                    # For condition_mismatch append -CONDITION, for zero_stock append -CONDITION too
                    _conditioned_ref = target_ref if r["match_status"] == "condition_mismatch" else target_ref + "-" + condition
                    ok, action, error_msg = _create_catalog_product(
                        mysql_cur, None, _conditioned_ref, condition, new_val,
                        override_name=correct_name
                    )
                    if not ok and action == "exists":
                        _actual_ref = error_msg
                        # MySQL doesn't allow subquery on same table — fetch id first
                        _id_row = _fetchone(mysql_cur,
                            "SELECT id FROM catalog_product"
                            " WHERE reference=%s AND `condition`=%s"
                            " ORDER BY is_active DESC LIMIT 1",
                            (_actual_ref, condition)
                        )
                        if _id_row:
                            _execute(mysql_cur,
                                f"UPDATE catalog_product SET {col}=%s, is_active=1, updated_at=NOW(), prisjakt=0,"
                                f" `condition`=COALESCE(`condition`, %s)"
                                " WHERE id=%s",
                                (new_val, condition, _id_row[0])
                            )
                        action = "updated"
                        ok = True
                        error_msg = None
                    elif not ok:
                        raise Exception(error_msg or f"Failed to create {_conditioned_ref}")

            applied += 1

            # If the card was submitted as "damaged", mark it in MySQL
            if is_damaged:
                try:
                    mysql_cur.execute(
                        "UPDATE catalog_product SET damaged=1"
                        " WHERE REGEXP_REPLACE(reference, '^[#!$]+', '') = %s"
                        "   AND `condition` = %s LIMIT 1",
                        (target_ref, condition)
                    )
                except Exception:
                    pass

            # Update progress in postgres every 5 cards for polling
            if applied % 5 == 0:
                try:
                    _pg = get_conn(); _pgc = _pg.cursor()
                    _pgc.execute(
                        "UPDATE bronze.manabox_imports SET applied_count=%s WHERE import_id=%s",
                        (applied, import_id)
                    )
                    _pg.commit(); _pgc.close(); _pg.close()
                except Exception:
                    pass

            # prisjakt=0 and condition are already set in the UPDATE above
            # Do NOT run a second UPDATE by reference here — it would hit both
            # RTR-240F and RTR-240-F if both exist, causing double-updates

            # If action is blank/None, the operation failed silently (e.g. no template found)
            if not action:
                action    = "failed"
                error_msg = error_msg or "No template row found in MySQL"

            if action == "failed":
                # Log failure and skip delta write
                cur.execute("""
                    UPDATE bronze.manabox_import_rows
                    SET apply_action = 'failed', apply_error = %s
                    WHERE row_id = %s
                """, (error_msg, row_id))
                conn.commit()
                continue

            # Write to stock_delta so silver_stock reflects change immediately
            cur.execute("""
                INSERT INTO bronze.stock_delta (reference, condition, stock_a, is_active, source, card_name)
                VALUES (%s, %s, %s, 1, 'import', %s)
                ON CONFLICT (reference, condition) DO UPDATE
                    SET stock_a    = EXCLUDED.stock_a,
                        is_active  = 1,
                        changed_at = now(),
                        source     = 'import',
                        card_name  = EXCLUDED.card_name
            """, (target_ref, condition, new_val, r["name"]))

            # Mark row as successfully applied
            cur.execute("""
                UPDATE bronze.manabox_import_rows
                SET applied_at        = now(),
                    applied_reference = %s,
                    apply_action      = %s,
                    apply_error       = NULL
                WHERE row_id = %s
            """, (target_ref, action, row_id))
            conn.commit()

        except Exception as e:
            error_msg = str(e)
            # Record the failure on the row
            cur.execute("""
                UPDATE bronze.manabox_import_rows
                SET apply_error = %s
                WHERE row_id = %s
            """, (error_msg, row_id))
            conn.commit()

    mysql_cur.close()
    mysql_conn.close()

    # Update batch status and applied count
    cur.execute("""
        UPDATE bronze.manabox_imports
        SET status        = 'confirmed',
            confirmed_at  = now(),
            applied_count = %s
        WHERE import_id = %s
    """, (applied, import_id))
    conn.commit()
    cur.close()
    conn.close()

    preview = _build_preview(import_id)
    preview["applied_count"] = applied
    return preview


@app.post("/import/{import_id}/confirm-async")
def confirm_import_async(import_id: int):
    """
    Start confirm in background thread and return immediately.
    Poll GET /import/{id}/status to track progress.
    """
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT status, row_count FROM bronze.manabox_imports WHERE import_id=%s",
                (import_id,))
    batch = cur.fetchone()
    cur.close(); conn.close()

    if not batch:
        raise HTTPException(status_code=404, detail="Import not found")
    if batch["status"] == "confirmed":
        raise HTTPException(status_code=400, detail="Already confirmed")
    if batch["status"] == "confirming":
        raise HTTPException(status_code=400, detail="Already in progress")

    # Start background thread
    t = _threading.Thread(target=_run_confirm_background, args=(import_id,), daemon=True)
    t.start()

    return {
        "import_id": import_id,
        "status":    "confirming",
        "row_count": batch["row_count"],
        "message":   "Confirm started. Poll GET /import/{id}/status for progress."
    }


@app.get("/import/{import_id}/status")
def import_status(import_id: int):
    """Poll this while confirm is running. Returns progress info."""
    batch = fetchone("""
        SELECT import_id, status, row_count, matched_count, applied_count,
               verify_ok, verify_fail, verified_at, confirmed_at
        FROM bronze.manabox_imports WHERE import_id = %s
    """, (import_id,))
    if not batch:
        raise HTTPException(status_code=404, detail="Import not found")
    return batch


@app.get("/import/{import_id}/verify")
def verify_import(import_id: int):
    """Cross-check applied rows against MySQL to confirm changes landed."""
    import re as _re

    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT row_id, name, matched_reference, applied_reference,
               alphaspel_condition, new_stock_value, apply_action
        FROM bronze.manabox_import_rows
        WHERE import_id = %s AND apply_action IN ('updated','inserted')
        ORDER BY name
    """, (import_id,))
    rows = [dict(r) for r in cur.fetchall()]
    cur.close(); conn.close()

    if not rows:
        return {"import_id": import_id, "verified": 0, "failed": 0, "results": []}

    # Build all reference variants we need to look up
    # For each row, try: exact ref, legacy foil (CMA-111F), -NM suffix, -CONDITION suffix
    def ref_variants(ref, condition):
        base   = _re.sub(r'-F$', '', ref)
        base   = _re.sub(r'([0-9])([A-Z]+)$', r'\1', base)
        legacy = base + 'F' if ref.endswith('-F') else ref
        return list(dict.fromkeys([ref, legacy, ref + '-NM', ref + '-' + condition]))

    # Collect all candidates across all rows
    row_variants = []
    all_candidates = set()
    for r in rows:
        ref       = r["applied_reference"] or r["matched_reference"] or ""
        condition = r["alphaspel_condition"] or "NM"
        variants  = ref_variants(ref, condition)
        row_variants.append((r, ref, condition, variants))
        all_candidates.update(variants)

    # Single MySQL batch query
    mysql_conn = get_mysql_conn()
    mysql_cur  = mysql_conn.cursor(buffered=True)

    all_list = list(all_candidates)
    ph       = ",".join(["%s"] * len(all_list))
    _rx = "^[#!$]+"
    mysql_cur.execute(
        f"SELECT REGEXP_REPLACE(reference,%s,%s), stock_a, `condition`, updated_at"
        f" FROM catalog_product"
        f" WHERE REGEXP_REPLACE(reference,%s,%s) IN ({ph})"
        f"   AND is_active = 1"
        f" ORDER BY is_active DESC, id DESC",
        [_rx, "", _rx, ""] + all_list
    )
    # Build lookup: clean_ref -> best row (first = highest priority)
    mysql_lookup = {}
    for row in mysql_cur.fetchall():
        clean_ref = row[0]
        if clean_ref not in mysql_lookup:
            mysql_lookup[clean_ref] = {"stock_a": row[1], "condition": row[2], "updated_at": row[3]}
    mysql_cur.close()
    mysql_conn.close()

    results  = []
    verified = 0
    failed   = 0

    for r, ref, condition, variants in row_variants:
        expected = r["new_stock_value"]

        # Find first matching variant in MySQL
        found = None
        found_ref = None
        for v in variants:
            if v in mysql_lookup:
                row_data  = mysql_lookup[v]
                # Check condition matches (or is NULL)
                rc = row_data["condition"]
                if rc is None or rc == condition:
                    found     = row_data
                    found_ref = v
                    break

        if found:
            actual      = int(found["stock_a"] or 0)
            actual_cond = found["condition"]
            updated_at  = str(found["updated_at"]) if found["updated_at"] else None
            ok    = (actual == expected)
            issue = None
            if not ok:
                issue = f"Expected stock={expected}, got stock={actual}"
            elif actual_cond is None:
                issue = "condition is still NULL"
                ok = False
            if ok: verified += 1
            else:  failed += 1
        else:
            actual = actual_cond = updated_at = found_ref = None
            ok    = False
            issue = "Row not found in MySQL"
            failed += 1

        results.append({
            "name":        r["name"],
            "reference":   ref,
            "actual_ref":  found_ref,
            "condition":   condition,
            "actual_cond": actual_cond,
            "expected":    expected,
            "actual":      actual,
            "updated_at":  updated_at,
            "ok":          ok,
            "issue":       issue,
        })

    # Store summary in postgres
    conn2 = get_conn()
    cur2  = conn2.cursor()
    cur2.execute("""
        UPDATE bronze.manabox_imports
        SET verify_ok   = %s,
            verify_fail = %s,
            verified_at = now()
        WHERE import_id = %s
    """, (verified, failed, import_id))
    conn2.commit()
    cur2.close(); conn2.close()

    # Fetch applied_count from import batch for the summary screen
    conn3 = get_conn()
    cur3  = conn3.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur3.execute("SELECT applied_count, row_count FROM bronze.manabox_imports WHERE import_id=%s",
                 (import_id,))
    batch = cur3.fetchone()
    cur3.close(); conn3.close()
    applied_count = batch["applied_count"] if batch and batch["applied_count"] else len(rows)

    return {
        "import_id":     import_id,
        "verified":      verified,
        "failed":        failed,
        "applied_count": applied_count,
        "results":       results,
    }


@app.post("/import/{import_id}/cancel")
def cancel_import(import_id: int):
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        "SELECT import_id, status FROM bronze.manabox_imports WHERE import_id = %s",
        (import_id,)
    )
    existing = cur.fetchone()
    if not existing:
        cur.close(); conn.close()
        raise HTTPException(status_code=404, detail="Import not found")
    if existing["status"] == "confirmed":
        cur.close(); conn.close()
        raise HTTPException(status_code=400, detail="Cannot cancel a confirmed import")
    # Delete rows and batch entirely so the file can be re-uploaded
    cur.execute("DELETE FROM bronze.manabox_import_rows WHERE import_id = %s", (import_id,))
    cur.execute("DELETE FROM bronze.manabox_imports WHERE import_id = %s", (import_id,))
    conn.commit()
    cur.close()
    conn.close()
    return {"import_id": import_id, "status": "cancelled"}


@app.post("/import/{import_id}/revoke")
def revoke_import(import_id: int):
    """
    Undo a confirmed import: subtract each row's delta from MySQL stock,
    update stock_delta, and mark the import as 'revoked'.
    Stock is never reduced below 0. If other imports added stock after this
    one, only this import's delta is subtracted.
    """
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("SELECT status FROM bronze.manabox_imports WHERE import_id = %s", (import_id,))
    batch = cur.fetchone()
    if not batch:
        cur.close(); conn.close()
        raise HTTPException(status_code=404, detail="Import not found")
    if batch["status"] != "confirmed":
        cur.close(); conn.close()
        raise HTTPException(
            status_code=400,
            detail=f"Can only revoke confirmed imports (current status: {batch['status']})"
        )

    cur.execute("""
        SELECT row_id, name, applied_reference, alphaspel_condition, delta, apply_action
        FROM bronze.manabox_import_rows
        WHERE import_id = %s
          AND apply_action IN ('updated', 'inserted')
          AND delta > 0
          AND applied_reference IS NOT NULL
    """, (import_id,))
    rows = [dict(r) for r in cur.fetchall()]

    mysql_conn = get_mysql_conn()
    mysql_cur  = mysql_conn.cursor()

    reverted = 0
    errors   = []

    for r in rows:
        ref       = r["applied_reference"]
        condition = r["alphaspel_condition"]
        delta     = r["delta"]

        try:
            if r["apply_action"] == "inserted":
                # Row was created by this import — zero it out and deactivate
                mysql_cur.execute(
                    "UPDATE catalog_product"
                    " SET stock_a = 0, is_active = 0, updated_at = NOW()"
                    " WHERE REGEXP_REPLACE(reference, '^[#!$]+', '') = %s"
                    "   AND `condition` = %s",
                    (ref, condition)
                )
            else:
                # Row existed before — subtract only our delta
                mysql_cur.execute(
                    "UPDATE catalog_product"
                    " SET stock_a = GREATEST(0, stock_a - %s), updated_at = NOW()"
                    " WHERE REGEXP_REPLACE(reference, '^[#!$]+', '') = %s"
                    "   AND `condition` = %s",
                    (delta, ref, condition)
                )

            # Read back new stock so stock_delta stays consistent
            mysql_cur.execute(
                "SELECT stock_a, is_active FROM catalog_product"
                " WHERE REGEXP_REPLACE(reference, '^[#!$]+', '') = %s"
                "   AND `condition` = %s"
                " ORDER BY is_active DESC, id DESC LIMIT 1",
                (ref, condition)
            )
            mysql_row = mysql_cur.fetchone()
            try: mysql_cur.fetchall()
            except: pass
            new_stock = int(mysql_row[0]) if mysql_row else 0
            active    = int(mysql_row[1]) if mysql_row else 0

            # Upsert stock_delta to reflect the reverted state
            cur.execute("""
                INSERT INTO bronze.stock_delta
                    (reference, condition, stock_a, is_active, source, card_name)
                VALUES (%s, %s, %s, %s, 'revoke', %s)
                ON CONFLICT (reference, condition) DO UPDATE
                    SET stock_a    = EXCLUDED.stock_a,
                        is_active  = EXCLUDED.is_active,
                        changed_at = now(),
                        source     = 'revoke',
                        card_name  = EXCLUDED.card_name
            """, (ref, condition, new_stock, active, r["name"]))

            reverted += 1

        except Exception as e:
            errors.append({"reference": ref, "condition": condition, "error": str(e)})

    mysql_cur.close()
    mysql_conn.close()

    cur.execute(
        "UPDATE bronze.manabox_imports SET status = 'revoked' WHERE import_id = %s",
        (import_id,)
    )
    conn.commit()
    cur.close()
    conn.close()

    return {
        "import_id": import_id,
        "status":    "revoked",
        "reverted":  reverted,
        "errors":    errors,
    }


@app.delete("/import/pending")
def clear_pending_imports():
    """Clear all non-confirmed imports — use when cancel leaves stale records."""
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        "SELECT import_id FROM bronze.manabox_imports WHERE status != 'confirmed'"
    )
    ids = [r["import_id"] for r in cur.fetchall()]
    if ids:
        cur.execute(
            "DELETE FROM bronze.manabox_import_rows WHERE import_id = ANY(%s)", (ids,)
        )
        cur.execute(
            "DELETE FROM bronze.manabox_imports WHERE import_id = ANY(%s)", (ids,)
        )
    conn.commit()
    cur.close(); conn.close()
    return {"cleared": len(ids), "import_ids": ids}


@app.get("/import/history")
def import_history():
    return fetchall("""
        SELECT import_id, filename, uploaded_at, status,
               confirmed_at, row_count, matched_count, applied_count,
               verify_ok, verify_fail, verified_at
        FROM bronze.manabox_imports
        ORDER BY uploaded_at DESC
        LIMIT 50
    """)

# ============================================================
#  BULK SET IMPORT ENDPOINTS
# ============================================================

@app.get("/bulk/sets/{set_code}/cards")
def bulk_get_set_cards(set_code: str):
    """
    Fetch all cards for a set from silver_cards sorted by zero-padded collector number,
    then enrich with current MySQL stock in a single batch query.
    """
    rows = fetchall("""
        SELECT
            scryfall_id,
            name,
            set_code,
            set_name,
            collector_number,
            rarity,
            image_url_small,
            COALESCE(sell_price_sek, 0)      AS sell_price_sek,
            COALESCE(sell_price_foil_sek, 0) AS sell_price_foil_sek,
            CASE
                -- Pure numeric: FEM-002
                WHEN collector_number ~ '^[0-9]+$'
                THEN upper(set_code) || '-' || lpad(collector_number, 3, '0')
                -- Numeric + letter suffix like 2a, 10b: FEM-002a
                WHEN collector_number ~ '^[0-9]+[a-zA-Z]+$'
                THEN upper(set_code) || '-' ||
                     lpad(REGEXP_REPLACE(collector_number, '[^0-9]', '', 'g'), 3, '0') ||
                     lower(REGEXP_REPLACE(collector_number, '[0-9]', '', 'g'))
                -- Fully alphanumeric (promo etc): keep as-is uppercase
                ELSE upper(set_code) || '-' || upper(collector_number)
            END AS reference
        FROM silver.silver_cards
        WHERE set_code = lower(%s)
        ORDER BY
            -- Natural sort: numeric part first, then alpha suffix
            -- So 1, 2, 2a, 2b, 3, 10, 100 sorts correctly
            CAST(REGEXP_REPLACE(collector_number, '[^0-9]', '', 'g') AS INTEGER),
            REGEXP_REPLACE(collector_number, '[0-9]', '', 'g')
    """, (set_code.lower(),))

    if not rows:
        raise HTTPException(status_code=404,
            detail=f"Set '{set_code}' not found in silver_cards")

    # Single MySQL batch query for all refs
    all_refs = [r["reference"] for r in rows]
    mysql_conn = get_mysql_conn()
    mysql_cur  = mysql_conn.cursor(buffered=True)
    placeholders = ",".join(["%s"] * len(all_refs))
    # Get base reference (strip condition/foil suffix) to aggregate across all variants
    # e.g. KTK-001, KTK-001-F, KTK-001-NM all roll up to KTK-001
    # We use LEFT(ref, LOCATE('-', ref, 5)-1) approach but simpler: strip trailing -XX and -F
    mysql_cur.execute(
        f"SELECT"
        f"  REGEXP_REPLACE(reference, '^[#!$]+', '') AS clean_ref,"
        f"  SUM(stock_a) AS total_stock_this_ref,"
        f"  MAX(sold_last_year) AS sold_last_year,"
        f"  MAX(sold_total) AS sold_total"
        f" FROM catalog_product"
        f" WHERE REGEXP_REPLACE(reference, '^[#!$]+', '') IN ({placeholders})"
        f"   AND is_active = 1"
        f" GROUP BY clean_ref",
        all_refs
    )
    # stock_map: exact ref -> stock in that specific row
    _stock_rows = mysql_cur.fetchall()
    stock_map = {
        row[0]: {
            "stock":          int(row[1] or 0),
            "sold_last_year": int(row[2] or 0),
            "sold_total":     int(row[3] or 0),
        }
        for row in _stock_rows
    }

    # Get total stock + sales across ALL printings of each card name.
    # Approach: use PostgreSQL silver_stock to find ALL references that share
    # the same scryfall card name as any card in this set, then batch-query
    # MySQL for those references. Immune to colon issues in set/card names.

    # Step 1: get all scryfall names in this set
    scryfall_names = list(set(r["name"] for r in rows))

    # Step 2: from PostgreSQL, find all silver_stock references that match
    # any of those card names (across all sets and conditions)
    pg_conn2 = get_conn()
    pg_cur2  = pg_conn2.cursor()
    name_ph  = ",".join(["%s"] * len(scryfall_names))
    pg_cur2.execute(
        f"SELECT ss.reference, sc.name"
        f" FROM silver.silver_stock ss"
        f" JOIN silver.silver_cards sc ON sc.scryfall_id = ss.scryfall_id"
        f" WHERE sc.name IN ({name_ph})"
        f"   AND ss.reference IS NOT NULL",
        scryfall_names
    )
    # Build name -> [references] map
    name_to_refs = {}
    for ref, name in pg_cur2.fetchall():
        name_to_refs.setdefault(name, set()).add(ref)
    pg_cur2.close()
    pg_conn2.close()

    # Step 3: query MySQL for all those references in one shot
    all_cross_refs = list({r for refs in name_to_refs.values() for r in refs})
    base_stock_map = {}
    if all_cross_refs:
        cross_ph = ",".join(["%s"] * len(all_cross_refs))
        mysql_cur.execute(
            f"SELECT"
            f"  REGEXP_REPLACE(reference, '^[#!$]+', '') AS clean_ref,"
            f"  SUM(stock_a)        AS total_stock,"
            f"  SUM(sold_last_year) AS sold_ly,"
            f"  SUM(sold_total)     AS sold_tot"
            f" FROM catalog_product"
            f" WHERE REGEXP_REPLACE(reference, '^[#!$]+', '') IN ({cross_ph})"
            f"   AND is_active = 1"
            f" GROUP BY clean_ref",
            all_cross_refs
        )
        # ref -> totals
        ref_totals = {}
        for row in mysql_cur.fetchall():
            ref_totals[row[0]] = (int(row[1] or 0), int(row[2] or 0), int(row[3] or 0))

        # Aggregate per card name
        for name, refs in name_to_refs.items():
            total_stock  = sum(ref_totals.get(r, (0,0,0))[0] for r in refs)
            sold_ly      = sum(ref_totals.get(r, (0,0,0))[1] for r in refs)
            sold_tot     = sum(ref_totals.get(r, (0,0,0))[2] for r in refs)
            base_stock_map[name] = {
                "total_all_conditions": total_stock,
                "sold_last_year_all":   sold_ly,
                "sold_total_all":       sold_tot,
            }
    mysql_cur.close()
    mysql_conn.close()

    cards = []
    for r in rows:
        ref = r["reference"]
        card_name = r["name"]
        cards.append({
            "scryfall_id":         r["scryfall_id"] or "",
            "name":                r["name"] or "",
            "set_code":            r["set_code"] or "",
            "set_name":            r["set_name"] or "",
            "collector_number":    r["collector_number"] or "",
            "rarity":              r["rarity"] or "",
            "image_url_small":     r["image_url_small"] or "",
            "sell_price_sek":      float(r["sell_price_sek"]),
            "sell_price_foil_sek": float(r["sell_price_foil_sek"]),
            "reference":           ref,
            "current_stock":       stock_map[ref]["stock"] if ref in stock_map else 0,
            "sold_last_year":      stock_map[ref]["sold_last_year"] if ref in stock_map else 0,
            "sold_total":          stock_map[ref]["sold_total"] if ref in stock_map else 0,
            "in_mysql":            ref in stock_map,
            # Totals across ALL conditions and foil variants of this card
            "total_stock_all":     base_stock_map.get(card_name, {}).get("total_all_conditions", 0),
            "sold_last_year_all":  base_stock_map.get(card_name, {}).get("sold_last_year_all", 0),
            "sold_total_all":      base_stock_map.get(card_name, {}).get("sold_total_all", 0),
        })

    return {
        "set_code":   set_code.upper(),
        "set_name":   rows[0]["set_name"] if rows else "",
        "card_count": len(cards),
        "cards":      cards,
    }


@app.post("/bulk/confirm")
def bulk_confirm(payload: dict):
    """
    Confirm a bulk set import.
    Payload: { "set_code": "ECL", "rows": [ { "scryfall_id", "reference", "name",
              "condition", "foil", "quantity", "set_name" }, ... ] }
    Filters out rows with quantity=0, then processes same as CSV import.
    """
    from datetime import datetime

    set_code = payload.get("set_code", "BULK")
    rows     = payload.get("rows", [])

    # Filter zero quantity
    rows = [r for r in rows if int(r.get("quantity", 0)) > 0]
    if not rows:
        raise HTTPException(status_code=400, detail="No rows with quantity > 0")

    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Create an import batch
    cur.execute(
        "INSERT INTO bronze.manabox_imports (filename, file_hash, row_count, status)"
        " VALUES (%s, %s, %s, 'confirming') RETURNING import_id",
        (f"bulk_{set_code}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.bulk",
         hashlib.md5(str(rows).encode()).hexdigest(),
         len(rows))
    )
    import_id = cur.fetchone()["import_id"]
    conn.commit()

    # Stage rows
    for r in rows:
        condition = r.get("condition", "NM")
        is_foil   = r.get("foil", False)
        quantity  = int(r.get("quantity", 0))
        ref       = r.get("reference", "")
        if is_foil and not ref.endswith("-F"):
            ref = ref + "-F"

        cur.execute(
            "INSERT INTO bronze.manabox_import_rows"
            " (import_id, name, set_code, set_name, collector_number, foil, rarity,"
            "  quantity, scryfall_id, manabox_condition, alphaspel_condition,"
            "  matched_reference, target_stock_col, match_status, match_tier,"
            "  current_stock_a, current_stock_b, current_stock_c,"
            "  new_stock_value, delta)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'stock_a','matched','bulk_import',0,0,0,%s,%s)",
            (import_id,
             r.get("name", ""),
             r.get("set_code", set_code),
             r.get("set_name", ""),
             r.get("collector_number", ""),
             "foil" if is_foil else "normal",
             r.get("rarity", ""),
             quantity,
             r.get("scryfall_id", ""),
             condition.lower(),
             condition,
             ref,
             int(r.get("current_stock", 0)) + quantity,
             quantity)
        )
    conn.commit()

    # Now run the confirm logic — reuse confirm_import
    # Update batch status first
    cur.execute(
        "UPDATE bronze.manabox_imports SET matched_count=%s WHERE import_id=%s",
        (len(rows), import_id)
    )
    conn.commit()
    cur.close()
    conn.close()

    # Delegate to confirm endpoint
    return confirm_import(import_id)


# ============================================================
#  TRADE-IN ENDPOINTS
# ============================================================

@app.get("/tradein/card-options")
def tradein_card_options(
    name:     str,
    set_code: Optional[str] = Query(None),
):
    """
    Supports the trade-in editing dropdowns.

    Without set_code: returns all sets where the card exists, sorted newest first.
    With set_code:    returns all printings (collector numbers / variants) for that
                      card within the set — useful for picking 2a vs 2b vs 2c etc.
    """
    if set_code:
        rows = fetchall("""
            SELECT scryfall_id, name, set_code, set_name,
                   collector_number, foil, nonfoil, image_url_small,
                   released_at
            FROM silver.silver_cards
            WHERE upper(name)     = upper(%s)
              AND lower(set_code) = lower(%s)
            ORDER BY
                CAST(REGEXP_REPLACE(collector_number, '[^0-9]', '', 'g') AS INTEGER),
                REGEXP_REPLACE(collector_number, '[0-9]', '', 'g')
        """, (name, set_code))
    else:
        rows = fetchall("""
            SELECT DISTINCT set_code, set_name, released_at
            FROM silver.silver_cards
            WHERE upper(name) = upper(%s)
            ORDER BY released_at DESC NULLS LAST, set_code
        """, (name,))

    if not rows:
        raise HTTPException(status_code=404, detail=f"No printings found for '{name}'")
    return rows


def _calculate_tradein(rows_data: list, eur_sek_rate: float) -> list:
    """Calculate trade-in value for each row based on business rules."""

    pricing = _load_pricing()
    bv = pricing.get("rules", {}).get("buy_valuation", {})

    def _bv(key, default):
        rule = bv.get(key, {})
        if rule and rule.get("is_active", True):
            return float(rule["value"])
        return default

    BASE_PCT         = _bv("base_pct", 80) / 100
    COMMONS_MIN_EUR  = _bv("commons_min_eur", 0.25)
    THRESH_LOW       = int(_bv("stock_threshold_low", 20))
    THRESH_MID       = int(_bv("stock_threshold_mid", 30))
    THRESH_HIGH      = int(_bv("stock_threshold_high", 40))
    DEMAND_BONUS     = _bv("demand_bonus", 1.10)
    DEMAND_MIN_SOLD  = int(_bv("demand_min_sold", 4))
    COND_FN          = _bv("cond_fn", 0.90)
    COND_GD          = _bv("cond_gd", 0.80)
    COND_PR          = _bv("cond_pr", 0.70)
    LANG_PENALTY     = _bv("lang_penalty", 0.80)

    # ── MySQL: separate foil vs non-foil stock per card name ─────────
    # Foil refs end with -F (new) or digit+F (legacy e.g. RTR-240F).
    # Only non-foil stock counts toward the acceptance threshold.
    mysql_conn = get_mysql_conn()
    mysql_cur  = mysql_conn.cursor(buffered=True)

    all_names = list(set(r["name"] for r in rows_data if r.get("name")))
    if all_names:
        mysql_cur.execute(
            "SELECT SUBSTRING_INDEX(name, ': ', -1) AS card_name,"
            " SUM(CASE WHEN reference REGEXP '-F(-[A-Z]+)?$|[0-9]F$'"
            "          THEN stock_a ELSE 0 END) AS foil_stock,"
            " SUM(CASE WHEN reference NOT REGEXP '-F(-[A-Z]+)?$|[0-9]F$'"
            "          THEN stock_a ELSE 0 END) AS nonfoil_stock,"
            " SUM(sold_last_year) AS sold_ly"
            " FROM catalog_product"
            " WHERE (name LIKE %s OR name LIKE %s) AND is_active=1"
            " GROUP BY card_name",
            ("%Magic löskort%", "%Magic Löskort%")
        )
        stock_map = {
            row[0]: {
                "foil_stock":    int(row[1] or 0),
                "nonfoil_stock": int(row[2] or 0),
                "sold_ly":       int(row[3] or 0),
            }
            for row in mysql_cur.fetchall()
        }
    else:
        stock_map = {}

    mysql_cur.close()
    mysql_conn.close()

    # ── PostgreSQL: price data from silver_cards ──────────────────────
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    scryfall_ids = [r["scryfall_id"] for r in rows_data if r.get("scryfall_id")]
    if scryfall_ids:
        ph = ",".join(["%s"] * len(scryfall_ids))
        cur.execute(f"""
            SELECT scryfall_id, name, rarity, set_code, set_name,
                   price_trend_eur, sell_price_sek, sell_price_foil_sek,
                   price_trend_foil_eur
            FROM silver.silver_cards
            WHERE scryfall_id IN ({ph})
        """, scryfall_ids)
        price_map = {r["scryfall_id"]: dict(r) for r in cur.fetchall()}
    else:
        price_map = {}

    cur.close()
    conn.close()

    results = []
    for r in rows_data:
        sid       = r.get("scryfall_id", "")
        name      = r.get("name", "")
        condition = r.get("condition", "NM")
        language  = r.get("language", "en")
        foil      = r.get("foil", "normal") == "foil"
        qty       = int(r.get("quantity", 1))
        rarity    = r.get("rarity", "common").lower()

        sc             = price_map.get(sid, {})
        has_price_data = bool(sc)

        # Return None (not 0) when there is no price — lets frontend show '-'
        trend_eur_raw = sc.get("price_trend_foil_eur" if foil else "price_trend_eur") if sc else None
        sell_sek_raw  = sc.get("sell_price_foil_sek"  if foil else "sell_price_sek")  if sc else None
        trend_eur = float(trend_eur_raw) if trend_eur_raw is not None else None
        sell_sek  = float(sell_sek_raw)  if sell_sek_raw  is not None else None

        stock_info    = stock_map.get(name, {"foil_stock": 0, "nonfoil_stock": 0, "sold_ly": 0})
        foil_stock    = stock_info["foil_stock"]
        nonfoil_stock = stock_info["nonfoil_stock"]
        sold_ly       = stock_info["sold_ly"]
        total_stock   = foil_stock + nonfoil_stock

        # ── Base value: BASE_PCT% of Cardmarket trend in SEK ─────────
        base_sek = round(trend_eur * eur_sek_rate * BASE_PCT, 2) if trend_eur else 0

        notes      = []
        multiplier = 1.0

        # Dynamic acceptance threshold — rises with sales velocity
        if sold_ly >= 10:
            threshold = THRESH_HIGH
        elif sold_ly >= 5:
            threshold = THRESH_MID
        else:
            threshold = THRESH_LOW

        # Over-threshold check uses NON-FOIL stock only.
        # Foil cards are still accepted if we have fewer than 4 foil copies.
        over_threshold = nonfoil_stock >= threshold
        if foil and over_threshold:
            blocked_by_stock = foil_stock >= 4
        else:
            blocked_by_stock = over_threshold

        # ── Zero-value rules ─────────────────────────────────────────
        is_common_uncommon = rarity in ("common", "uncommon")
        trend_for_check    = trend_eur or 0.0

        if is_common_uncommon and trend_for_check < COMMONS_MIN_EUR:
            multiplier = 0
            notes.append(f"Common/uncommon under \u20ac{COMMONS_MIN_EUR} = 0")
        elif blocked_by_stock:
            multiplier = 0
            if foil:
                notes.append(f"≥4 foil in stock ({foil_stock}), "
                              f"{nonfoil_stock} non-foil (threshold {threshold}) = 0")
            elif is_common_uncommon:
                notes.append(f"Common/uncommon: {nonfoil_stock} non-foil in stock "
                              f"(threshold {threshold}) = 0")
            else:
                notes.append(f"{nonfoil_stock} non-foil in stock "
                              f"(threshold {threshold}) = 0")

        # ── Demand bonus ─────────────────────────────────────────────
        if multiplier > 0 and total_stock == 0 and sold_ly >= DEMAND_MIN_SOLD:
            multiplier *= DEMAND_BONUS
            notes.append(f"Out of stock, sold {sold_ly} last year (+{int((DEMAND_BONUS-1)*100)}%)")

        # ── Condition discount ───────────────────────────────────────
        cond_disc = {"NM": 1.0, "FN": COND_FN, "GD": COND_GD, "PR": COND_PR}.get(condition, 1.0)
        if cond_disc < 1.0:
            multiplier *= cond_disc
            notes.append(f"Condition {condition} ({int(cond_disc * 100)}%)")

        # ── Language penalty ─────────────────────────────────────────
        if language and language.lower() not in ("en", "english", ""):
            multiplier *= LANG_PENALTY
            notes.append(f"Non-English language (-{int((1-LANG_PENALTY)*100)}%)")

        final_sek = round(base_sek * multiplier, 2) if multiplier > 0 else 0

        results.append({
            **r,
            "price_trend_eur":   trend_eur,
            "sell_price_sek":    sell_sek,
            "tradein_base_sek":  base_sek,
            "tradein_final_sek": final_sek,
            "tradein_total_sek": round(final_sek * qty, 2),
            "multiplier_notes":  "; ".join(notes) if notes else "OK",
            "stock_total":       total_stock,
            "sold_last_year":    sold_ly,
            # True only if card was not found in silver_cards at all.
            # Cards with 0 trade value due to business rules are NOT flagged.
            "missing_price":     not has_price_data,
        })

    return results


@app.post("/tradein/preview")
async def tradein_preview(file: UploadFile = File(...)):
    """Parse a Manabox CSV and return trade-in valuations without saving."""
    content_bytes = await file.read()
    text          = content_bytes.decode("utf-8-sig")

    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for r in reader:
        mc = r.get("Condition", "near_mint").strip().lower()
        ac = MANABOX_TO_ALPHASPEL_CONDITION.get(mc, "NM")
        rows.append({
            "name":             r.get("Name", "").strip(),
            "set_code":         r.get("Set code", "").strip(),
            "set_name":         r.get("Set name", "").strip(),
            "collector_number": r.get("Collector number", "").strip(),
            "foil":             r.get("Foil", "normal").strip().lower(),
            "rarity":           r.get("Rarity", "common").strip().lower(),
            "quantity":         int(r.get("Quantity", 1) or 1),
            "scryfall_id":      r.get("Scryfall ID", "").strip(),
            "condition":        ac,
            "language":         r.get("Language", "en").strip(),
        })

    if not rows:
        raise HTTPException(status_code=400, detail="CSV is empty or could not be parsed")

    # Get current EUR/SEK rate
    rate_row = fetchone("""
        SELECT rate_value FROM bronze.exchange_rates
        WHERE series_id = 'SEKEURPMI'
        ORDER BY rate_date DESC LIMIT 1
    """)
    eur_sek = float(rate_row["rate_value"]) if rate_row else 11.5

    # ── Merge rows with same card + condition + foil before valuation ─
    merged: dict = {}
    for r in rows:
        key = (
            r.get("scryfall_id") or f"{r.get('name')}|{r.get('set_code')}|{r.get('collector_number')}",
            r.get("condition", "NM"),
            r.get("foil", "normal"),
        )
        if key in merged:
            merged[key]["quantity"] += int(r.get("quantity", 1))
        else:
            merged[key] = {**r}
    rows = list(merged.values())

    valued = _calculate_tradein(rows, eur_sek)

    total_cards   = sum(r["quantity"] for r in valued)
    unique_cards  = len(valued)
    missing_price = [r["name"] for r in valued if r["missing_price"]]
    total_base    = sum(r["tradein_total_sek"] for r in valued)

    # Sort by set_code, then collector_number (numeric part first, then alpha suffix)
    def _tradein_sort_key(r):
        cn = r.get("collector_number", "") or ""
        num = int(''.join(filter(str.isdigit, cn)) or 9999)
        alpha = ''.join(filter(str.isalpha, cn))
        return (r.get("set_code", ""), num, alpha, r.get("foil", "normal"))

    valued.sort(key=_tradein_sort_key)

    _bm = _load_pricing().get("rules", {}).get("buy_multiplier", {})
    def _bm_val(key, default):
        r = _bm.get(key, {})
        return float(r["value"]) if r and r.get("is_active", True) else default

    return {
        "total_cards":        total_cards,
        "unique_cards":       unique_cards,
        "missing_price":      missing_price,
        "total_base_sek":     _round5(total_base),
        "trade_cards_sek":    _round5(total_base * _bm_val("trade_cards", 1.00)),
        "trade_products_sek": _round5(total_base * _bm_val("trade_products", 0.70)),
        "trade_cash_sek":     _round5(total_base * _bm_val("trade_cash", 0.50)),
        "eur_sek_rate":       eur_sek,
        "rows":               valued,
    }


@app.post("/tradein/submit")
async def tradein_submit(payload: dict):
    """
    Save a trade-in session and return a token.
    Payload: { email, trade_type, rows: [...edited rows...] }
    """
    import random, string

    email      = payload.get("email", "").strip()
    trade_type = payload.get("trade_type", "cards")
    rows       = payload.get("rows", [])

    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email required")
    if not rows:
        raise HTTPException(status_code=400, detail="No rows to submit")

    rate_row = fetchone("""
        SELECT rate_value FROM bronze.exchange_rates
        WHERE series_id = 'SEKEURPMI'
        ORDER BY rate_date DESC LIMIT 1
    """)
    eur_sek = float(rate_row["rate_value"]) if rate_row else 11.5

    valued = _calculate_tradein(rows, eur_sek)
    total_base = sum(r["tradein_total_sek"] for r in valued)
    _bm = _load_pricing().get("rules", {}).get("buy_multiplier", {})
    def _bm_val(key, default):
        r = _bm.get(key, {})
        return float(r["value"]) if r and r.get("is_active", True) else default
    multipliers = {
        "cards":    _bm_val("trade_cards",    1.00),
        "products": _bm_val("trade_products", 0.70),
        "cash":     _bm_val("trade_cash",     0.50),
    }
    total_value = _round5(total_base * multipliers.get(trade_type, 1.00))

    # Generate 6-character token
    token = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))

    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        INSERT INTO bronze.tradein_sessions (email, token, trade_type, total_value, status)
        VALUES (%s, %s, %s, %s, 'pending') RETURNING session_id
    """, (email, token, trade_type, total_value))
    session_id = cur.fetchone()["session_id"]

    for r in valued:
        cur.execute("""
            INSERT INTO bronze.tradein_rows
            (session_id, name, set_code, set_name, collector_number, foil,
             rarity, quantity, scryfall_id, condition, language,
             price_trend_eur, sell_price_sek, tradein_base_sek, tradein_final_sek,
             multiplier_notes, stock_total, sold_last_year)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            session_id, r["name"], r["set_code"], r["set_name"],
            r["collector_number"], r["foil"], r["rarity"], r["quantity"],
            r["scryfall_id"], r["condition"], r["language"],
            r["price_trend_eur"], r["sell_price_sek"],
            r["tradein_base_sek"], r["tradein_final_sek"],
            r["multiplier_notes"], r["stock_total"], r["sold_last_year"]
        ))

    conn.commit()
    cur.close(); conn.close()

    return {
        "session_id": session_id,
        "token":      token,
        "email":      email,
        "trade_type": trade_type,
        "total_value_sek": total_value,
        "message": f"Trade-in registered! Show token {token} and email {email} at the store.",
    }


@app.get("/tradein/{token}")
def get_tradein(token: str):
    """Fetch a trade-in session by token (for store staff or customer lookup)."""
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT s.*, s.total_value AS total_value_sek, array_agg(row_to_json(r)) AS rows
        FROM bronze.tradein_sessions s
        LEFT JOIN bronze.tradein_rows r ON r.session_id = s.session_id
        WHERE s.token = %s
        GROUP BY s.session_id
    """, (token.upper(),))
    session = cur.fetchone()
    cur.close(); conn.close()

    if not session:
        raise HTTPException(status_code=404, detail=f"Token '{token}' not found")

    return dict(session)


@app.put("/tradein/{token}/rows/{row_id}")
def update_tradein_row(token: str, row_id: int, body: dict):
    """Edit a trade-in row (qty/condition/foil/printing) and recalculate its price."""
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Verify session exists and is still editable
    cur.execute(
        "SELECT session_id, status, trade_type FROM bronze.tradein_sessions WHERE token = %s",
        (token.upper(),)
    )
    session = cur.fetchone()
    if not session:
        cur.close(); conn.close()
        raise HTTPException(status_code=404, detail="Token not found")
    if session["status"] not in ("pending",):
        cur.close(); conn.close()
        raise HTTPException(status_code=409, detail=f"Session is already {session['status']} — cannot edit")

    # Fetch current row
    cur.execute(
        "SELECT * FROM bronze.tradein_rows WHERE row_id = %s AND session_id = %s",
        (row_id, session["session_id"])
    )
    row = cur.fetchone()
    if not row:
        cur.close(); conn.close()
        raise HTTPException(status_code=404, detail="Row not found")

    # Apply edits — only fields that were sent
    updated = dict(row)
    for field in ("quantity", "condition", "foil", "scryfall_id",
                  "set_code", "set_name", "collector_number", "language", "name", "rarity"):
        if field in body:
            updated[field] = body[field]

    # Recalculate price for this one row
    rate_row = fetchone("""
        SELECT rate_value FROM bronze.exchange_rates
        WHERE series_id = 'SEKEURPMI' ORDER BY rate_date DESC LIMIT 1
    """)
    eur_sek = float(rate_row["rate_value"]) if rate_row else 11.5

    valued = _calculate_tradein([updated], eur_sek)
    v = valued[0]

    # Save updated row
    cur.execute("""
        UPDATE bronze.tradein_rows
        SET quantity          = %s,
            condition         = %s,
            foil              = %s,
            scryfall_id       = %s,
            set_code          = %s,
            set_name          = %s,
            collector_number  = %s,
            language          = %s,
            name              = %s,
            rarity            = %s,
            price_trend_eur   = %s,
            sell_price_sek    = %s,
            tradein_base_sek  = %s,
            tradein_final_sek = %s,
            multiplier_notes  = %s,
            stock_total       = %s,
            sold_last_year    = %s
        WHERE row_id = %s
    """, (
        v["quantity"], v["condition"], v["foil"], v["scryfall_id"],
        v["set_code"], v["set_name"], v["collector_number"], v.get("language", updated.get("language", "en")),
        v["name"], v.get("rarity", updated.get("rarity", "common")),
        v.get("price_trend_eur"), v.get("sell_price_sek"),
        v["tradein_base_sek"], v["tradein_final_sek"],
        v.get("multiplier_notes"), v.get("stock_total"), v.get("sold_last_year"),
        row_id
    ))

    # Recalculate session total from all rows
    _bm = _load_pricing().get("rules", {}).get("buy_multiplier", {})
    def _bm_val(key, default):
        r = _bm.get(key, {})
        return float(r["value"]) if r and r.get("is_active", True) else default
    multipliers = {
        "cards":    _bm_val("trade_cards",    1.00),
        "products": _bm_val("trade_products", 0.70),
        "cash":     _bm_val("trade_cash",     0.50),
    }
    mult = multipliers.get(session["trade_type"], 1.00)
    cur.execute("""
        SELECT COALESCE(SUM(tradein_final_sek), 0) AS base_total
        FROM bronze.tradein_rows WHERE session_id = %s
    """, (session["session_id"],))
    base_total = float(cur.fetchone()["base_total"])
    new_total  = _round5(base_total * mult)
    cur.execute(
        "UPDATE bronze.tradein_sessions SET total_value = %s WHERE session_id = %s",
        (new_total, session["session_id"])
    )

    conn.commit()
    cur.close(); conn.close()

    return {
        **v,
        "row_id":           row_id,
        "session_total_sek": new_total,
    }


@app.post("/tradein/{token}/import-to-stock")
def tradein_import_to_stock(token: str):
    """Import a confirmed trade-in directly into MySQL stock (same as CSV import)."""
    conn = get_conn()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT s.session_id, s.status, s.email,
               json_agg(row_to_json(r)) AS rows
        FROM bronze.tradein_sessions s
        JOIN bronze.tradein_rows r ON r.session_id = s.session_id
        WHERE s.token = %s
        GROUP BY s.session_id
    """, (token.upper(),))
    session = cur.fetchone()
    cur.close(); conn.close()

    if not session:
        raise HTTPException(status_code=404, detail="Token not found")
    if session["status"] == "imported":
        # Second call — return the existing import so the frontend can poll/verify it
        existing = fetchone(
            "SELECT import_id, status, applied_count, row_count"
            " FROM bronze.manabox_imports"
            " WHERE filename LIKE %s ORDER BY import_id DESC LIMIT 1",
            (f"tradein_{token.upper()}%",)
        )
        if existing:
            return {
                "import_id": existing["import_id"],
                "token":     token,
                "row_count": existing.get("row_count", 0),
                "status":    existing["status"],
                "message":   "Trade-in already imported. Resuming existing import.",
            }
        raise HTTPException(status_code=400, detail="Already imported")

    # Build rows in the same format as CSV import and delegate to confirm
    import_rows = []
    for r in session["rows"]:
        import_rows.append({
            "name":             r["name"],
            "set_code":         r["set_code"],
            "set_name":         r["set_name"],
            "collector_number": r["collector_number"],
            "foil":             r["foil"],
            "rarity":           r["rarity"],
            "quantity":         r["quantity"],
            "manabox_id":       "",
            "scryfall_id":      r["scryfall_id"],
            "purchase_price":   str(r.get("tradein_final_sek", 0)),
            "manabox_condition":r["condition"].lower(),
            "alphaspel_condition": r["condition"],
            "language":         r["language"],
        })

    # Create import batch, stage rows, run matching cascade, then confirm async
    conn2 = get_conn()
    cur2  = conn2.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur2.execute(
        "INSERT INTO bronze.manabox_imports (filename, file_hash, row_count, status)"
        " VALUES (%s, %s, %s, 'previewed') RETURNING import_id",
        (f"tradein_{token}.tradein",
         hashlib.md5(token.encode()).hexdigest(),
         len(import_rows))
    )
    import_id = cur2.fetchone()["import_id"]

    for r in import_rows:
        cur2.execute(
            "INSERT INTO bronze.manabox_import_rows"
            " (import_id,name,set_code,set_name,collector_number,foil,rarity,"
            "  quantity,manabox_id,scryfall_id,purchase_price,manabox_condition,"
            "  alphaspel_condition,language)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (import_id, r["name"], r["set_code"], r["set_name"], r["collector_number"],
             r["foil"], r["rarity"], r["quantity"], r["manabox_id"], r["scryfall_id"],
             r["purchase_price"], r["manabox_condition"], r["alphaspel_condition"], r["language"])
        )
    conn2.commit()

    # ── Run the same five-tier matching cascade as CSV import ─────────
    for tier_name, sql in MATCHING_TIERS:
        try:
            cur2.execute("SAVEPOINT tier_match")
            cur2.execute(sql, (import_id,))
            cur2.execute("RELEASE SAVEPOINT tier_match")
        except Exception:
            cur2.execute("ROLLBACK TO SAVEPOINT tier_match")

    cur2.execute("""
        UPDATE bronze.manabox_import_rows
        SET match_status = 'not_in_alphaspel', match_tier = 'no_match'
        WHERE import_id = %s AND match_status IS NULL
    """, (import_id,))

    _apply_stock_delta_to_import(cur2, import_id)

    cur2.execute("""
        UPDATE bronze.manabox_imports SET
            matched_count = (SELECT COUNT(*) FROM bronze.manabox_import_rows
                             WHERE import_id = %s AND match_status IN ('matched','zero_stock')),
            applied_count = 0
        WHERE import_id = %s
    """, (import_id, import_id))

    conn2.commit()
    cur2.close(); conn2.close()

    # Mark trade-in session as imported
    conn3 = get_conn()
    cur3  = conn3.cursor()
    cur3.execute(
        "UPDATE bronze.tradein_sessions SET status='imported', imported_at=now() WHERE token=%s",
        (token.upper(),)
    )
    conn3.commit(); cur3.close(); conn3.close()

    # Start async confirm — frontend should poll GET /import/{id}/status
    # then call GET /import/{id}/verify once status = 'confirmed'
    t = _threading.Thread(target=_run_confirm_background, args=(import_id,), daemon=True)
    t.start()

    return {
        "import_id":  import_id,
        "token":      token,
        "row_count":  len(import_rows),
        "status":     "confirming",
        "message":    f"Import started. Poll GET /import/{import_id}/status every 2s. "
                      f"When status='confirmed', call GET /import/{import_id}/verify.",
    }

# ============================================================
#  AGENT SEARCH  (Claude-powered natural language → filters)
# ============================================================

_AGENT_SYSTEM_PROMPT = """\
You are a search assistant for a Magic: The Gathering card store.
Convert the user's natural language query into structured search filters.

You have tools to look up real data from the store:
- Use find_sets ONLY when the user mentions a specific set by name (e.g. "Bloomburrow", "Duskmourn")
- Use find_cards ONLY when the user mentions a specific card name you need to verify
- Do NOT use tools for price, color, rarity, CMC, type, or other filters — set those directly

Available search filters (only set what the user implies):
- name        : partial card name match
- set_code    : exact set code(s), comma-separated for multiple e.g. "blb,lci"
                → always use find_sets to resolve a set name to its code
- color       : W (white) U (blue) B (black) R (red) G (green) or combinations e.g. "WU"
- rarity      : common / uncommon / rare / mythic
- type_line   : partial match e.g. "Creature", "Instant", "Planeswalker", "Dragon", "Token"
                → IMPORTANT: "tokens", "token cards", "creature tokens" etc → type_line="Token"
                  Never use name= for the word "token" — it is a card type, not a card name
- oracle_text : keyword search in card text e.g. "flying", "draw a card"
- min_cmc     : minimum converted mana cost (number)
- max_cmc     : maximum converted mana cost (number)
- min_price   : minimum sell price in SEK (number) e.g. 50
- max_price   : maximum sell price in SEK (number) e.g. 100
- in_stock    : true = only cards currently in stock
- foil        : true = only foil, false = only non-foil

For each non-null filter, add one chip object to the chips array:
{"label": "<human label>", "param": "<filter key>", "value": "<filter value>"}

Label rules:
- set_code  → the set name e.g. "Bloomburrow"
- color     → W→"White" U→"Blue" B→"Black" R→"Red" G→"Green" WU→"White/Blue" etc.
- rarity    → Title Case e.g. "Rare", "Mythic"
- type_line → the exact string e.g. "Creature"
- oracle_text → the search term e.g. "flying"
- min_cmc   → "CMC ≥ 3"
- max_cmc   → "CMC ≤ 5"
- min_price → "Price ≥ 50 kr"
- max_price → "Price ≤ 100 kr"
- in_stock  → "In Stock"
- foil      → "Foil" or "Non-Foil"

Respond ONLY with valid JSON (no markdown, no explanation):
{"filters":{"name":null,"set_code":null,"color":null,"rarity":null,"type_line":null,"oracle_text":null,"min_cmc":null,"max_cmc":null,"min_price":null,"max_price":null,"in_stock":null,"foil":null},"chips":[{"label":"...","param":"...","value":"..."}]}
"""

_AGENT_TOOLS = [
    {
        "name": "find_sets",
        "description": (
            "Look up Magic: The Gathering sets in this store by name or partial name. "
            "Returns a list of {set_name, set_code} pairs. "
            "Always call this when the user mentions a set by name — never guess the code."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Set name or partial name, e.g. 'Bloomburrow', 'Tarkir', 'Commander'"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "find_cards",
        "description": (
            "Look up whether a SPECIFIC card name exists in this store. "
            "Only use this when the user names a specific card and you need to verify the exact spelling. "
            "Do NOT use this to browse cards by price, color, rarity, or any other attribute — "
            "those are handled directly via filters, no tool needed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A specific card name to look up, e.g. 'Lightning Bolt', 'Jace the Mind Sculptor'"
                }
            },
            "required": ["query"]
        }
    }
]

def _agent_find_sets(query: str) -> list:
    return fetchall(
        "SELECT DISTINCT set_code, set_name FROM gold.gold_cards "
        "WHERE set_name ILIKE %s ORDER BY set_name LIMIT 15",
        (f"%{query}%",)
    )

def _agent_find_cards(query: str) -> list:
    rows = fetchall(
        "SELECT DISTINCT name FROM gold.gold_cards "
        "WHERE name ILIKE %s ORDER BY name LIMIT 15",
        (f"%{query}%",)
    )
    return [r["name"] for r in rows]

def _agent_run_tool(name: str, inputs: dict) -> str:
    import json as _json
    if name == "find_sets":
        return _json.dumps(_agent_find_sets(inputs.get("query", "")))
    if name == "find_cards":
        return _json.dumps(_agent_find_cards(inputs.get("query", "")))
    return "[]"


class AgentSearchRequest(BaseModel):
    query: str

@app.post("/agent/search")
def agent_search(req: AgentSearchRequest):
    """Convert a natural language query into card search filters using Claude."""
    import json as _json
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")

    try:
        import anthropic as _anthropic
        client = _anthropic.Anthropic(api_key=api_key)

        messages = [{"role": "user", "content": req.query}]

        # Agentic loop — Claude may call tools before returning the final JSON
        for _ in range(6):  # max 6 iterations (tool calls) before giving up
            response = client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=1024,
                system=_AGENT_SYSTEM_PROMPT,
                tools=_AGENT_TOOLS,
                messages=messages,
            )

            if response.stop_reason == "end_turn":
                # Final answer — parse the JSON from the text block
                raw = next(
                    (b.text for b in response.content if b.type == "text"), ""
                ).strip()
                if raw.startswith("```"):
                    raw = re.sub(r"^```(?:json)?\s*", "", raw)
                    raw = re.sub(r"\s*```$", "", raw.strip())
                if not raw:
                    return {"filters": {}, "chips": [], "raw_query": req.query}
                try:
                    result = _json.loads(raw)
                except _json.JSONDecodeError:
                    return {"filters": {}, "chips": [], "raw_query": req.query}
                filters = {k: v for k, v in result.get("filters", {}).items() if v is not None}
                chips   = result.get("chips", [])
                return {"filters": filters, "chips": chips, "raw_query": req.query}

            if response.stop_reason == "tool_use":
                # Execute each tool Claude requested, then continue the loop
                messages.append({"role": "assistant", "content": response.content})
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        output = _agent_run_tool(block.name, block.input)
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": output,
                        })
                messages.append({"role": "user", "content": tool_results})
                continue

            break  # unexpected stop reason

        raise HTTPException(status_code=500, detail="Agent did not return a result")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent error: {str(e)}")


# ============================================================
#  PRICING CONFIG ENDPOINTS
# ============================================================

@app.get("/pricing/rules")
def get_pricing_rules():
    """Return all pricing rules grouped by category."""
    rows = fetchall("""
        SELECT id, category, rule_key, label, value, suffix, is_active, sort_order, changed_at, changed_by
        FROM bronze.pricing_rules
        ORDER BY category, sort_order
    """)
    grouped = {}
    for r in rows:
        cat = r["category"]
        if cat not in grouped:
            grouped[cat] = []
        r["value"] = float(r["value"])
        r["changed_at"] = r["changed_at"].isoformat() if r["changed_at"] else None
        grouped[cat].append(r)
    return grouped


@app.put("/pricing/rules/{rule_id}")
def update_pricing_rule(rule_id: int, payload: dict):
    """Update a pricing rule's value and/or is_active status."""
    global _pricing_cache_ts
    updates = []
    params = []
    if "value" in payload:
        updates.append("value = %s")
        params.append(float(payload["value"]))
    if "is_active" in payload:
        updates.append("is_active = %s")
        params.append(bool(payload["is_active"]))
    if "changed_by" in payload:
        updates.append("changed_by = %s")
        params.append(str(payload["changed_by"]))
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates.append("changed_at = NOW()")
    params.append(rule_id)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE bronze.pricing_rules SET {', '.join(updates)} WHERE id = %s",
                params
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Rule not found")
        conn.commit()
    finally:
        conn.close()
    _pricing_cache_ts = 0.0  # invalidate cache
    return {"ok": True}


@app.get("/pricing/audit")
def get_pricing_audit():
    """Return the 50 most recent pricing changes across rules and ranges."""
    rules = fetchall("""
        SELECT 'rule' AS type, id, category AS section,
               label AS name, value::text AS new_value, suffix,
               changed_at, changed_by
        FROM bronze.pricing_rules
        WHERE changed_by IS NOT NULL
    """)
    ranges = fetchall("""
        SELECT 'range' AS type, id, 'sell_price_range' AS section,
               label AS name, magic_number::text AS new_value, NULL AS suffix,
               changed_at, changed_by
        FROM bronze.pricing_ranges
        WHERE changed_by IS NOT NULL
    """)
    combined = list(rules) + list(ranges)
    for r in combined:
        if r.get("changed_at"):
            r["changed_at"] = r["changed_at"].isoformat()
    combined.sort(key=lambda x: x["changed_at"] or "", reverse=True)
    return combined[:50]


@app.post("/pricing/reset")
def reset_pricing_to_defaults(payload: dict = {}):
    """Restore all pricing rules and ranges to their original default values."""
    global _pricing_cache_ts

    DEFAULT_RULES = [
        # buy_valuation
        ("buy_valuation", "base_pct",              80,    "%"),
        ("buy_valuation", "commons_min_eur",        0.25,  "EUR"),
        ("buy_valuation", "stock_threshold_low",   20,    "units"),
        ("buy_valuation", "stock_threshold_mid",   30,    "units"),
        ("buy_valuation", "stock_threshold_high",  40,    "units"),
        ("buy_valuation", "demand_bonus",           1.10,  "x"),
        ("buy_valuation", "demand_min_sold",        4,     "sold/yr"),
        ("buy_valuation", "cond_fn",                0.90,  "x"),
        ("buy_valuation", "cond_gd",                0.80,  "x"),
        ("buy_valuation", "cond_pr",                0.70,  "x"),
        ("buy_valuation", "lang_penalty",           0.80,  "x"),
        # buy_multiplier
        ("buy_multiplier", "trade_cards",           1.00,  "x"),
        ("buy_multiplier", "trade_products",        0.70,  "x"),
        ("buy_multiplier", "trade_cash",            0.50,  "x"),
        # sell_condition
        ("sell_condition", "disc_mt",               0.00,  "%"),
        ("sell_condition", "disc_nm",               0.00,  "%"),
        ("sell_condition", "disc_vf",               0.10,  "%"),
        ("sell_condition", "disc_fn",               0.10,  "%"),
        ("sell_condition", "disc_vg",               0.10,  "%"),
        ("sell_condition", "disc_gd",               0.15,  "%"),
        ("sell_condition", "disc_fr",               0.20,  "%"),
        ("sell_condition", "disc_pr",               0.25,  "%"),
        ("sell_condition", "disc_null",             0.10,  "%"),
        # sell_minimum
        ("sell_minimum", "min_common_uncommon",     5,     "SEK"),
        ("sell_minimum", "min_rare_mythic_slow",    10,    "SEK"),
        ("sell_minimum", "min_rare_mythic_active",  15,    "SEK"),
        ("sell_minimum", "min_sold_threshold",      1,     "sold/yr"),
        # internal
        ("internal", "wholesale_pct",               50,    "%"),
    ]

    DEFAULT_RANGES = [
        (0,     0.24,  1.74, 5,    "Under €0.25 (min 5 SEK)"),
        (0.25,  0.50,  3.48, None, "€0.25 – €0.50"),
        (0.50,  1.00,  2.61, None, "€0.50 – €1.00"),
        (1.00,  5.00,  1.74, None, "€1.00 – €5.00"),
        (5.00,  10.00, 1.65, None, "€5.00 – €10.00"),
        (10.00, 20.00, 1.57, None, "€10.00 – €20.00"),
        (20.00, 50.00, 1.46, None, "€20.00 – €50.00"),
        (50.00, 100.00,1.30, None, "€50 – €100"),
        (100.0, 500.0, 1.20, None, "€100 – €500"),
        (500.0, None,  1.10, None, "€500+"),
    ]

    changed_by = payload.get("changed_by", "system/reset")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for cat, key, val, _ in DEFAULT_RULES:
                cur.execute("""
                    UPDATE bronze.pricing_rules
                    SET value = %s, is_active = TRUE, changed_at = NOW(), changed_by = %s
                    WHERE category = %s AND rule_key = %s
                """, (val, changed_by, cat, key))

            for i, (rmin, rmax, magic, fixed, label) in enumerate(DEFAULT_RANGES, 1):
                cur.execute("""
                    UPDATE bronze.pricing_ranges
                    SET magic_number = %s, fixed_sek = %s, is_active = TRUE,
                        changed_at = NOW(), changed_by = %s
                    WHERE sort_order = %s
                """, (magic, fixed, changed_by, i))

        conn.commit()
    finally:
        conn.close()

    _pricing_cache_ts = 0.0
    return {"ok": True, "message": "All pricing rules restored to defaults."}


@app.get("/pricing/ranges")
def get_pricing_ranges():
    """Return all pricing ranges with pre-computed SEK anchors for display."""
    rows = fetchall("""
        SELECT id, range_min, range_max, magic_number, fixed_sek, label, is_active, sort_order, changed_at, changed_by
        FROM bronze.pricing_ranges
        ORDER BY sort_order
    """)
    for r in rows:
        r["range_min"] = float(r["range_min"])
        r["range_max"] = float(r["range_max"]) if r["range_max"] is not None else None
        r["magic_number"] = float(r["magic_number"])
        r["fixed_sek"] = float(r["fixed_sek"]) if r["fixed_sek"] is not None else None
        r["changed_at"] = r["changed_at"].isoformat() if r["changed_at"] else None

    # Attach interpolated SEK anchors so the frontend can display accurate price ranges
    rate = 11.5  # reference rate for display; actual pricing uses live rate
    rate_row = fetchone("SELECT rate_value FROM bronze.exchange_rates WHERE series_id='SEKEURPMI' ORDER BY rate_date DESC LIMIT 1")
    if rate_row:
        rate = float(rate_row["rate_value"])

    anchors = _build_range_anchors(rows, rate)
    for r, (rmin, rmax, lower_sek, upper_sek, magic, fixed) in zip(rows, anchors):
        r["display_lower_sek"] = round(lower_sek / 5) * 5 if lower_sek else None
        r["display_upper_sek"] = round(upper_sek / 5) * 5 if upper_sek else None

    return rows


@app.put("/pricing/ranges/{range_id}")
def update_pricing_range(range_id: int, payload: dict):
    """Update a pricing range's magic_number and/or is_active."""
    global _pricing_cache_ts
    updates = []
    params = []
    if "magic_number" in payload:
        updates.append("magic_number = %s")
        params.append(float(payload["magic_number"]))
    if "fixed_sek" in payload:
        updates.append("fixed_sek = %s")
        params.append(float(payload["fixed_sek"]) if payload["fixed_sek"] is not None else None)
    if "is_active" in payload:
        updates.append("is_active = %s")
        params.append(bool(payload["is_active"]))
    if "changed_by" in payload:
        updates.append("changed_by = %s")
        params.append(str(payload["changed_by"]))
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates.append("changed_at = NOW()")
    params.append(range_id)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE bronze.pricing_ranges SET {', '.join(updates)} WHERE id = %s",
                params
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Range not found")
        conn.commit()
    finally:
        conn.close()
    _pricing_cache_ts = 0.0  # invalidate cache
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Admin endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/admin/match-stats")
def admin_match_stats():
    """Section 1: % of MySQL active stock rows matched in PostgreSQL gold_cards."""
    row = fetchone("""
        SELECT
            COUNT(*)                                          AS total_mysql,
            COUNT(g.reference)                               AS matched,
            COUNT(*) - COUNT(g.reference)                    AS unmatched,
            ROUND(
                COUNT(g.reference)::numeric / NULLIF(COUNT(*), 0) * 100, 1
            )                                                AS match_pct
        FROM (
            SELECT DISTINCT reference
            FROM bronze.mysql_stock
            WHERE loaded_date = (SELECT MAX(loaded_date) FROM bronze.mysql_stock)
              AND is_active = 1
              AND (stock_a > 0 OR stock_b > 0 OR stock_c > 0)
        ) ms
        LEFT JOIN gold.gold_cards g USING (reference)
    """)
    return row


@app.get("/admin/unmatched")
def admin_unmatched():
    """Section 1: Active MySQL rows with stock > 0 that have no gold_cards match."""
    rows = fetchall("""
        SELECT
            ms.reference,
            ms.name,
            ms.stock_a,
            ms.stock_b,
            ms.stock_c,
            ms.condition,
            rc.set_code         AS corrected_set_code,
            rc.collector_number AS corrected_collector_number
        FROM (
            SELECT reference, name, stock_a, stock_b, stock_c, condition
            FROM bronze.mysql_stock
            WHERE loaded_date = (SELECT MAX(loaded_date) FROM bronze.mysql_stock)
              AND is_active = 1
              AND stock_a > 0
        ) ms
        LEFT JOIN gold.gold_cards g USING (reference)
        LEFT JOIN bronze.reference_corrections rc USING (reference)
        WHERE g.reference IS NULL
        ORDER BY ms.stock_a DESC, ms.reference
    """)
    return rows


@app.post("/admin/corrections")
def admin_save_correction(payload: dict):
    """Section 1: Save a reference → (set_code, collector_number) correction."""
    ref = (payload.get("reference") or "").strip()
    sc  = (payload.get("set_code") or "").strip().lower()
    cn  = (payload.get("collector_number") or "").strip().lstrip("0") or "0"
    if not ref or not sc or not cn:
        raise HTTPException(status_code=400, detail="reference, set_code, collector_number required")
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO bronze.reference_corrections (reference, set_code, collector_number)
                VALUES (%s, %s, %s)
                ON CONFLICT (reference) DO UPDATE
                  SET set_code = EXCLUDED.set_code,
                      collector_number = EXCLUDED.collector_number,
                      updated_at = NOW()
            """, [ref, sc, cn])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@app.delete("/admin/corrections/{reference:path}")
def admin_delete_correction(reference: str):
    """Section 1: Remove a reference correction."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM bronze.reference_corrections WHERE reference = %s", [reference])
            deleted = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Correction not found")
    return {"ok": True}


@app.get("/admin/no-price")
def admin_no_price():
    """Section 2: Cards in gold_cards with stock > 0 but no Cardmarket price."""
    rows = fetchall("""
        SELECT
            g.reference,
            g.name,
            g.set_code,
            g.collector_number,
            g.is_foil,
            g.condition,
            g.stock_a,
            g.price_trend_eur,
            g.sell_price_sek,
            regexp_replace(ms.name, '^Magic löskort:[[:space:]]*', '') AS mysql_name
        FROM gold.gold_cards g
        LEFT JOIN LATERAL (
            SELECT name FROM bronze.mysql_stock
            WHERE reference = g.reference
              AND loaded_date = (SELECT MAX(loaded_date) FROM bronze.mysql_stock)
            LIMIT 1
        ) ms ON true
        WHERE g.in_stock = true
          AND CASE WHEN g.is_foil
                THEN (g.price_trend_foil_eur IS NULL OR g.price_trend_foil_eur = 0)
                     AND (g.price_avg_foil_eur IS NULL OR g.price_avg_foil_eur = 0)
                ELSE (g.price_trend_eur IS NULL OR g.price_trend_eur = 0)
                     AND (g.price_avg_eur IS NULL OR g.price_avg_eur = 0)
              END
          AND NOT (g.set_code LIKE 't%%' OR g.type_line LIKE '%%Token%%')
          AND NOT EXISTS (
              SELECT 1 FROM bronze.price_overrides po
              WHERE po.set_code = g.set_code
                AND po.collector_number = g.collector_number
                AND po.is_foil = g.is_foil
          )
        ORDER BY g.name, g.set_code
        LIMIT 500
    """)
    return rows


@app.get("/admin/card-lookup")
def admin_card_lookup(set_code: str, collector_number: str):
    """Section 3: Look up a card by coordinates for price override preview."""
    row = fetchone("""
        SELECT name, set_code, set_name, collector_number, is_foil,
               rarity, image_url_small, image_url_normal,
               price_trend_eur, sell_price_sek, sell_price_foil_sek, eur_sek_rate
        FROM gold.gold_cards
        WHERE LOWER(set_code) = LOWER(%s) AND collector_number = %s
        LIMIT 1
    """, [set_code, collector_number])
    if not row:
        raise HTTPException(status_code=404, detail="Card not found")
    return row


@app.get("/admin/price-overrides")
def admin_list_price_overrides():
    """Section 3: List all manual price overrides."""
    rows = fetchall("""
        SELECT po.set_code, po.collector_number, po.is_foil, po.price_sek,
               po.created_at, po.updated_at,
               gc.name, gc.set_name, gc.image_url_small
        FROM bronze.price_overrides po
        LEFT JOIN gold.gold_cards gc
               ON LOWER(gc.set_code) = po.set_code
              AND gc.collector_number = po.collector_number
              AND gc.is_foil = po.is_foil
        ORDER BY po.set_code, po.collector_number, po.is_foil
    """)
    return rows


@app.post("/admin/price-overrides")
def admin_save_price_override(payload: dict):
    """Section 3: Set a manual price override.
    Accepts price_sek directly, price_eur (processed through full pricing logic), or percent_increase."""
    sc      = (payload.get("set_code") or "").strip().lower()
    cn      = (payload.get("collector_number") or "").strip()
    is_foil = bool(payload.get("is_foil", False))
    price_sek = payload.get("price_sek")

    if price_sek is None:
        price_eur = payload.get("price_eur")
        if price_eur is not None:
            # Convert EUR through the same pricing logic used for Cardmarket prices
            pricing   = _load_pricing()
            rate      = pricing["eur_sek_rate"]
            ranges    = pricing["ranges"]
            sell_min  = pricing.get("sell_minimums", {})
            card      = fetchone(
                "SELECT rarity, sold_last_year FROM gold.gold_cards WHERE LOWER(set_code)=%s AND collector_number=%s AND is_foil=%s LIMIT 1",
                [sc, cn, is_foil]
            )
            rarity        = (card or {}).get("rarity", "common")
            sold_last_year = (card or {}).get("sold_last_year")
            price_sek = _calc_sell_price(float(price_eur), rate, ranges, rarity,
                                         sold_last_year=sold_last_year, sell_minimums=sell_min)

    if price_sek is None:
        pct = payload.get("percent_increase")
        if pct is not None:
            col = "sell_price_foil_sek" if is_foil else "sell_price_sek"
            base = fetchone(
                f"SELECT {col} FROM gold.gold_cards WHERE LOWER(set_code)=%s AND collector_number=%s LIMIT 1",
                [sc, cn]
            )
            if not base or base.get(col) is None:
                raise HTTPException(status_code=400, detail="No base price found to apply percent to")
            price_sek = round(float(base[col]) * (1 + float(pct) / 100), 2)

    if not sc or not cn or price_sek is None:
        raise HTTPException(status_code=400, detail="set_code, collector_number, and price_sek/price_eur (or percent_increase) required")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO bronze.price_overrides (set_code, collector_number, is_foil, price_sek)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (set_code, collector_number, is_foil) DO UPDATE
                  SET price_sek = EXCLUDED.price_sek,
                      updated_at = NOW()
            """, [sc, cn, is_foil, price_sek])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "price_sek": price_sek}


@app.delete("/admin/price-overrides/{set_code}/{collector_number}")
def admin_delete_price_override(set_code: str, collector_number: str, is_foil: bool = False):
    """Section 3: Remove a manual price override."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM bronze.price_overrides WHERE set_code=%s AND collector_number=%s AND is_foil=%s",
                [set_code.lower(), collector_number, is_foil]
            )
            deleted = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Override not found")
    return {"ok": True}


# ─── Decklist Checker ─────────────────────────────────────────────────────────

def _parse_decklist(text: str) -> list[dict]:
    """
    Parse a MTGGoldfish-style decklist into [{qty, name, section}].
    Blank lines or '// Sideboard' / 'Sideboard' markers switch section to 'sideboard'.
    Lines starting with '//' (comments) or 'Deck' (filename header) are skipped.
    """
    entries = []
    section = "main"
    in_main = True  # first blank line flips to sideboard

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            if in_main:
                in_main = False
                section = "sideboard"
            continue
        if line.startswith("//") or line.lower().startswith("deck"):
            if "sideboard" in line.lower():
                section = "sideboard"
                in_main = False
            continue
        if line.lower() in ("sideboard", "sb:"):
            section = "sideboard"
            in_main = False
            continue

        # Accept "4 Card Name" or "4x Card Name"
        import re as _re
        m = _re.match(r'^(\d+)x?\s+(.+)$', line)
        if not m:
            continue
        qty = int(m.group(1))
        name = m.group(2).strip()
        # Strip set/collector annotations like "(MKM) 123" appended by some exporters
        name = _re.sub(r'\s*\([A-Z0-9]{2,6}\)\s*\d*$', '', name).strip()
        # Normalize split-card slash to Scryfall format: "A/B" or "A / B" → "A // B"
        name = _re.sub(r'\s*/+\s*', ' // ', name)
        entries.append({"qty": qty, "name": name, "section": section})

    return entries


@app.post("/decklist/search")
def decklist_search(body: dict):
    """
    Given a pasted decklist, return stock availability for every card.
    Body: { text: str, deck_name?: str }
    """
    text      = body.get("text", "").strip()
    deck_name = body.get("deck_name", "").strip()

    if not text:
        raise HTTPException(status_code=422, detail="text is required")

    entries = _parse_decklist(text)
    if not entries:
        raise HTTPException(status_code=422, detail="No cards found in decklist")

    # Build a lookup: lower(name) → list of entries (same card can appear in main + side)
    name_lower_set = list({e["name"].lower() for e in entries})

    # Batch query — all variants in stock for requested names
    sql = """
        SELECT
            scryfall_id,
            name,
            set_code,
            set_name,
            collector_number,
            rarity,
            type_line,
            mana_cost,
            colors,
            color_identity,
            image_url_normal,
            image_url_small,
            image_url_back,
            is_foil,
            in_stock,
            total_stock,
            stock_a,
            condition,
            condition_discount,
            sell_price_sek,
            sell_price_foil_sek,
            language,
            special_print,
            special_foil_type,
            is_signed,
            data_quality,
            match_type
        FROM gold.gold_cards
        WHERE LOWER(name) = ANY(%s)
        ORDER BY name, is_foil, sell_price_sek NULLS LAST, set_code
    """
    rows = fetchall(sql, [name_lower_set])
    rows = apply_delta(rows)

    # Fallback 1: split-card "A // B" entered as just "A" — already normalized above,
    # but handle legacy "A/B" format that slipped through
    found_lower = {r["name"].lower() for r in rows}
    split_lookups = []
    for e in entries:
        nl = e["name"].lower()
        if nl not in found_lower and " // " in nl:
            split_lookups.append(nl.split(" // ")[0].strip())
    if split_lookups:
        extra = fetchall(sql, [list(set(split_lookups))])
        extra = apply_delta(extra)
        rows += extra
        found_lower = {r["name"].lower() for r in rows}

    # Fallback 2: front-face-only name (e.g. "Elusive Otter" → "Elusive Otter // Grove's Bounty")
    # Use LIKE 'name //%' prefix search for any name still not resolved
    prefix_lookups = []
    for e in entries:
        nl = e["name"].lower()
        if nl not in found_lower and " // " not in nl:
            prefix_lookups.append(nl)
    if prefix_lookups:
        # Build a single query with OR-ed LIKE conditions
        like_clauses = " OR ".join(["LOWER(name) LIKE %s" for _ in prefix_lookups])
        like_params  = [p + " //%"  for p in prefix_lookups]
        prefix_sql = sql.replace("WHERE LOWER(name) = ANY(%s)", f"WHERE ({like_clauses})")
        extra = fetchall(prefix_sql, like_params)
        extra = apply_delta(extra)
        rows += extra

    # Group rows by lower(name)
    from collections import defaultdict
    variants_by_name: dict[str, list] = defaultdict(list)
    for r in rows:
        variants_by_name[r["name"].lower()].append(r)

    # Build per-entry results — resolve front-face name to full DFC name
    def _resolve_variants(name: str) -> list:
        nl = name.lower()
        # Exact match
        if nl in variants_by_name:
            return variants_by_name[nl]
        # Front-face prefix: find any key that starts with "nl // "
        prefix = nl + " // "
        for key, vals in variants_by_name.items():
            if key.startswith(prefix):
                return vals
        return []

    def _cheapest_price(variants: list) -> int | None:
        prices = []
        for v in variants:
            if not v.get("in_stock"):
                continue
            p = v["sell_price_foil_sek"] if v.get("is_foil") else v["sell_price_sek"]
            if p and p > 0:
                prices.append(int(round(p)))
        return min(prices) if prices else None

    results_main = []
    results_side = []

    for e in entries:
        variants = _resolve_variants(e["name"])
        in_stock_variants = [v for v in variants if v.get("in_stock") and v.get("total_stock", 0) > 0]
        total_avail = sum(v.get("total_stock", 0) for v in in_stock_variants)
        cheapest = _cheapest_price(in_stock_variants)

        entry = {
            "requested_name": e["name"],
            "requested_qty":  e["qty"],
            "total_available": total_avail,
            "can_fill":        total_avail >= e["qty"],
            "cheapest_price":  cheapest,
            "cheapest_total":  cheapest * e["qty"] if cheapest else None,
            "variants":        variants,
        }
        if e["section"] == "sideboard":
            results_side.append(entry)
        else:
            results_main.append(entry)

    # Summary
    def _summary(results: list) -> dict:
        total_qty     = sum(r["requested_qty"] for r in results)
        filled_qty    = sum(min(r["total_available"], r["requested_qty"]) for r in results)
        cheapest_cost = sum(r["cheapest_total"] or 0 for r in results)
        return {
            "total_cards":    total_qty,
            "filled_cards":   filled_qty,
            "missing_cards":  total_qty - filled_qty,
            "cheapest_sek":   cheapest_cost,
            "unique_names":   len(results),
            "names_found":    sum(1 for r in results if r["variants"]),
            "names_missing":  sum(1 for r in results if not r["variants"]),
        }

    return {
        "deck_name":  deck_name,
        "main":       results_main,
        "sideboard":  results_side,
        "summary_main": _summary(results_main),
        "summary_side": _summary(results_side),
    }

# ─────────────────────────────────────────────────────────────────────────────
# ANALYTICS
# ─────────────────────────────────────────────────────────────────────────────

def _analytics_row(cols, row):
    """Serialize a DB row to a dict, converting decimals/dates to JSON-safe types."""
    out = {}
    for i, v in enumerate(row):
        if v is None:
            out[cols[i]] = 0
        elif hasattr(v, "isoformat"):
            out[cols[i]] = str(v)
        else:
            try:
                out[cols[i]] = float(v)
            except (TypeError, ValueError):
                out[cols[i]] = v
    return out


@app.get("/analytics/summary")
def analytics_summary(year: int = None, include_other_games: bool = False):
    """
    KPI totals. Without ?year returns all-time.
    With ?year returns three rows: year-1, year, year+1.
    """
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Determine last actual data month (always based on MTG data)
            cur.execute("SELECT MAX(month_start) FROM gold.gold_sales_daily WHERE game = 'MTG'")
            last_row = cur.fetchone()[0]
            import datetime as _dt
            _today = _dt.date.today()
            last_data_year  = last_row.year  if last_row else _today.year
            last_data_month = last_row.month if last_row else _today.month

            game_cond = "" if include_other_games else "AND game = 'MTG'"

            if year is None:
                cur.execute(f"""
                    SELECT
                        null::int             AS year,
                        sum(units_sold)       AS units_sold,
                        sum(order_count)      AS order_count,
                        sum(revenue_sek)      AS revenue_sek,
                        sum(cost_sek)         AS cost_sek,
                        sum(profit_sek)       AS profit_sek
                    FROM gold.gold_sales_daily
                    WHERE 1=1 {game_cond}
                """)
                cols = [d[0] for d in cur.description]
                row  = cur.fetchone()
                return {"mode": "all_time", "data": [_analytics_row(cols, row)]}
            else:
                cur.execute(f"""
                    SELECT
                        order_year            AS year,
                        sum(units_sold)       AS units_sold,
                        sum(order_count)      AS order_count,
                        sum(revenue_sek)      AS revenue_sek,
                        sum(cost_sek)         AS cost_sek,
                        sum(profit_sek)       AS profit_sek
                    FROM gold.gold_sales_daily
                    WHERE order_year IN (%s, %s, %s) {game_cond}
                    GROUP BY order_year
                    ORDER BY order_year
                """, (year - 1, year, year + 1))
                cols = [d[0] for d in cur.description]
                rows = cur.fetchall()

                by_year = {int(r[0]): _analytics_row(cols, r) for r in rows}
                result  = []
                for y in (year - 1, year, year + 1):
                    if y in by_year:
                        row_dict = by_year[y]
                        # Mark as partial if this is the last year with data and it's incomplete
                        if y == last_data_year and last_data_month < 12:
                            months_elapsed = last_data_month
                            row_dict["is_partial"] = True
                            row_dict["projected_revenue_sek"] = round(
                                row_dict["revenue_sek"] / months_elapsed * 12, 0)
                            row_dict["projected_profit_sek"] = round(
                                row_dict["profit_sek"] / months_elapsed * 12, 0)
                            row_dict["projected_units_sold"] = round(
                                row_dict["units_sold"] / months_elapsed * 12, 0)
                        result.append(row_dict)
                    else:
                        result.append({"year": y, "units_sold": 0, "order_count": 0,
                                       "revenue_sek": 0, "cost_sek": 0, "profit_sek": 0})
                return {"mode": "year_comparison", "year": year, "data": result}
    finally:
        conn.close()


@app.get("/analytics/over-time")
def analytics_over_time(
    granularity:         str  = "month",   # day | week | month | year
    set_group:           str  = None,
    channel:             str  = None,
    year:                int  = None,
    include_other_games: bool = False,
):
    """
    Revenue/profit/units over time, bucketed by granularity.
    When include_other_games=true, returns mtg_units and other_units as separate fields.
    """
    bucket_col = {
        "day":   "order_date",
        "week":  "week_start",
        "month": "month_start",
        "year":  "year_start",
    }.get(granularity, "month_start")

    filters = []
    params  = []
    if set_group:
        filters.append("set_group = %s")
        params.append(set_group)
    if channel:
        filters.append("channel = %s")
        params.append(channel)
    if year:
        filters.append("order_year = %s")
        params.append(year)

    where = ("WHERE " + " AND ".join(filters)) if filters else ""

    if not include_other_games:
        filters.append("game = 'MTG'")
        where = "WHERE " + " AND ".join(filters)

    if include_other_games:
        sql = f"""
            SELECT
                {bucket_col}                                             AS period,
                sum(revenue_sek)                                         AS revenue_sek,
                sum(cost_sek)                                            AS cost_sek,
                sum(profit_sek)                                          AS profit_sek,
                sum(CASE WHEN game = 'MTG'  THEN units_sold ELSE 0 END) AS mtg_units,
                sum(CASE WHEN game != 'MTG' THEN units_sold ELSE 0 END) AS other_units
            FROM gold.gold_sales_daily
            {where}
            GROUP BY 1
            ORDER BY 1
        """
    else:
        sql = f"""
            SELECT
                {bucket_col}            AS period,
                sum(revenue_sek)        AS revenue_sek,
                sum(cost_sek)           AS cost_sek,
                sum(profit_sek)         AS profit_sek,
                sum(units_sold)         AS units_sold,
                sum(order_count)        AS order_count
            FROM gold.gold_sales_daily
            {where}
            GROUP BY 1
            ORDER BY 1
        """

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
        return [_analytics_row(cols, row) for row in rows]
    finally:
        conn.close()


@app.get("/analytics/by-set-code")
def analytics_by_set_code(year: int = None, limit: int = 20):
    """
    Revenue by set (3-letter SKU prefix). Top N sets + Others bucket.
    Joins to silver_cards to resolve set name where possible.
    """
    filters = ["oi.game = 'MTG'"]
    params  = []
    if year:
        filters.append("oi.order_year = %s")
        params.append(year)
    where = "WHERE " + " AND ".join(filters)

    # Distinct set names per set_code from silver_cards
    sql = f"""
        WITH set_names AS (
            SELECT lower(set_code) AS set_code, min(set_name) AS set_name
            FROM silver.silver_cards
            GROUP BY lower(set_code)
        ),
        by_prefix AS (
            SELECT
                upper(left(oi.sku, 3))                          AS set_prefix,
                coalesce(sn.set_name, upper(left(oi.sku, 3)))   AS display_name,
                sum(oi.total_revenue_sek)                        AS revenue_sek,
                sum(oi.total_cost_sek)                           AS cost_sek,
                sum(oi.profit_sek)                               AS profit_sek,
                sum(oi.quantity)                                 AS units_sold
            FROM silver.silver_order_items oi
            LEFT JOIN set_names sn ON sn.set_code = lower(left(oi.sku, 3))
            {where}
            GROUP BY upper(left(oi.sku, 3)), coalesce(sn.set_name, upper(left(oi.sku, 3)))
        ),
        ranked AS (
            SELECT *, row_number() OVER (ORDER BY revenue_sek DESC) AS rn
            FROM by_prefix
        )
        SELECT
            CASE WHEN rn <= %s THEN display_name ELSE 'Others' END AS display_name,
            CASE WHEN rn <= %s THEN set_prefix   ELSE 'OTH'    END AS set_prefix,
            sum(revenue_sek)  AS revenue_sek,
            sum(cost_sek)     AS cost_sek,
            sum(profit_sek)   AS profit_sek,
            sum(units_sold)   AS units_sold
        FROM ranked
        GROUP BY 1, 2
        ORDER BY revenue_sek DESC
    """
    params += [limit, limit]

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
        return [_analytics_row(cols, row) for row in rows]
    finally:
        conn.close()


@app.get("/analytics/by-channel")
def analytics_by_channel(year: int = None, include_other_games: bool = False):
    """In-store vs shipped split: revenue, profit, units."""
    filters = []
    params  = []
    if not include_other_games:
        filters.append("game = 'MTG'")
    if year:
        filters.append("order_year = %s")
        params.append(year)
    where = ("WHERE " + " AND ".join(filters)) if filters else ""

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT
                    channel,
                    sum(units_sold)   AS units_sold,
                    sum(revenue_sek)  AS revenue_sek,
                    sum(cost_sek)     AS cost_sek,
                    sum(profit_sek)   AS profit_sek
                FROM gold.gold_sales_daily
                {where}
                GROUP BY channel
                ORDER BY revenue_sek DESC
            """, params)
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
        return [_analytics_row(cols, row) for row in rows]
    finally:
        conn.close()


@app.get("/analytics/years")
def analytics_years():
    """List of years with sales data, for year picker in the frontend."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT order_year
                FROM gold.gold_sales_daily
                WHERE game = 'MTG'
                ORDER BY order_year
            """)
            return [row[0] for row in cur.fetchall()]
    finally:
        conn.close()


@app.get("/analytics/predictions")
def analytics_predictions(year: int, include_other_games: bool = False):
    """
    Returns predicted monthly revenue/profit starting from the last actual data point.
    - Remaining months of `year` if year == last_data_year
    - All 12 months of year+1 if year == last_data_year
    - All 12 months of `year` if year > last_data_year (no actual data yet)
    - Empty if year < last_data_year (historical — show actual data instead)

    Prediction method: avg of same month across last 3 years (partial fill) or 5 years (next year).
    """
    game_cond = "" if include_other_games else "AND game = 'MTG'"

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            import datetime as _dt, calendar as _cal
            _today = _dt.date.today()

            # Find last actual data month (always MTG-based for consistency)
            cur.execute("SELECT MAX(month_start), MAX(order_date) FROM gold.gold_sales_daily WHERE game = 'MTG'")
            ms_row = cur.fetchone()
            last_month_start = ms_row[0]
            last_order_date  = ms_row[1]

            last_data_year  = last_month_start.year  if last_month_start else _today.year
            last_data_month = last_month_start.month if last_month_start else _today.month

            # Determine last COMPLETE month: a month is complete only if the last
            # order falls on the final day of that month.  If the pipeline stopped
            # mid-month (e.g. Oct 12) the partial month is excluded so the chart
            # doesn't show a misleading dip.
            if last_order_date:
                last_day = _cal.monthrange(last_order_date.year, last_order_date.month)[1]
                if last_order_date.day < last_day:
                    # Partial month — step back one month
                    if last_order_date.month == 1:
                        last_complete_year  = last_order_date.year - 1
                        last_complete_month = 12
                    else:
                        last_complete_year  = last_order_date.year
                        last_complete_month = last_order_date.month - 1
                else:
                    last_complete_year  = last_order_date.year
                    last_complete_month = last_order_date.month
            else:
                last_complete_year  = last_data_year
                last_complete_month = last_data_month

            # Predictions start from the month after the last complete month
            pred_start_month = last_complete_month + 1
            pred_start_year  = last_complete_year
            if pred_start_month > 12:
                pred_start_month = 1
                pred_start_year += 1

            empty = {
                "year": year,
                "last_data_year": last_data_year, "last_data_month": last_data_month,
                "last_complete_year": last_complete_year, "last_complete_month": last_complete_month,
                "predictions": [],
                "predicted_year_revenue": 0, "predicted_year_profit": 0,
                "predicted_next_year_revenue": 0, "predicted_next_year_profit": 0,
                "predicted_next_year_units": 0,
            }
            if year < last_data_year:
                return empty

            # Pull monthly revenue/profit for historical reference years
            cur.execute(f"""
                SELECT
                    order_year,
                    order_month,
                    SUM(revenue_sek) AS monthly_revenue,
                    SUM(profit_sek)  AS monthly_profit,
                    SUM(units_sold)  AS monthly_units
                FROM gold.gold_sales_daily
                WHERE order_year BETWEEN %s AND %s {game_cond}
                GROUP BY order_year, order_month
            """, (year - 4, year))
            hist = {}
            for r in cur.fetchall():
                hist[(int(r[0]), int(r[1]))] = (
                    float(r[2] or 0), float(r[3] or 0), float(r[4] or 0),
                )

        def avg_month(target_month, ref_years):
            vals = [hist[(y, target_month)] for y in ref_years if (y, target_month) in hist]
            if not vals:
                return (0.0, 0.0, 0.0)
            return (
                sum(v[0] for v in vals) / len(vals),
                sum(v[1] for v in vals) / len(vals),
                sum(v[2] for v in vals) / len(vals),
            )

        # Use last 3 complete years as reference, with linear trend extrapolation.
        # Simple averaging underestimates future years for a growing business;
        # extrapolating the observed trend gives a more realistic projection.
        ref           = [last_data_year - 3, last_data_year - 2, last_data_year - 1]
        last_ref_year = last_data_year - 1   # most recent complete year in ref

        def trend_month(target_month, steps_ahead):
            """
            Fit a linear trend through `ref` for `target_month` and predict
            `steps_ahead` years beyond last_ref_year.
            Returns (revenue, profit, units).
            """
            def extrap(series):
                data = [(x, v) for x, v in enumerate(series) if v is not None and v > 0]
                if not data:
                    return 0.0
                if len(data) == 1:
                    return data[0][1]
                n       = len(data)
                mean_x  = sum(x for x, _ in data) / n
                mean_y  = sum(y for _, y in data) / n
                num     = sum((x - mean_x) * (y - mean_y) for x, y in data)
                den     = sum((x - mean_x) ** 2 for x, _ in data)
                b       = num / den if den else 0
                a       = mean_y - b * mean_x
                predict_x = data[-1][0] + steps_ahead
                return max(0.0, a + b * predict_x)

            rev_s    = [hist.get((y, target_month), (None,))[0] for y in ref]
            profit_s = [hist.get((y, target_month), (None, None))[1] for y in ref]
            units_s  = [hist.get((y, target_month), (None, None, None))[2] for y in ref]
            return extrap(rev_s), extrap(profit_s), extrap(units_s)

        predictions = []

        if year == last_data_year:
            partial_steps = last_data_year - last_ref_year          # = 1
            next_steps    = last_data_year + 1 - last_ref_year      # = 2

            # ── Remaining months of this year (from pred_start_month onward) ───
            # pred_start_month is the month after the last complete month, so the
            # chart bridges cleanly from the last full-data month.
            for m in range(pred_start_month if pred_start_year == year else 1, 13):
                rev, profit, units = trend_month(m, partial_steps)
                predictions.append({
                    "period":            f"{year}-{m:02d}-01",
                    "pred_revenue_sek":  round(rev),
                    "pred_profit_sek":   round(profit),
                    "pred_units":        round(units),
                    "pred_type":         "partial_year",
                })
            # ── All 12 months of next year ──────────────────────────────────────
            next_year = year + 1
            for m in range(1, 13):
                rev, profit, units = trend_month(m, next_steps)
                predictions.append({
                    "period":            f"{next_year}-{m:02d}-01",
                    "pred_revenue_sek":  round(rev),
                    "pred_profit_sek":   round(profit),
                    "pred_units":        round(units),
                    "pred_type":         "next_year",
                })
        else:
            # year > last_data_year: predict all 12 months of this future year
            steps = year - last_ref_year
            for m in range(1, 13):
                rev, profit, units = trend_month(m, steps)
                predictions.append({
                    "period":            f"{year}-{m:02d}-01",
                    "pred_revenue_sek":  round(rev),
                    "pred_profit_sek":   round(profit),
                    "pred_units":        round(units),
                    "pred_type":         "next_year",
                })

        # ── Aggregate KPI totals ── sum up the generated prediction rows ───────
        partial_rows = [p for p in predictions if p["pred_type"] == "partial_year"]
        next_rows    = [p for p in predictions if p["pred_type"] == "next_year"]

        if year == last_data_year:
            ytd_rev    = sum(hist.get((year, m), (0,0,0))[0] for m in range(1, last_data_month + 1))
            ytd_profit = sum(hist.get((year, m), (0,0,0))[1] for m in range(1, last_data_month + 1))
        else:
            ytd_rev = ytd_profit = 0

        remaining_rev    = sum(p["pred_revenue_sek"] for p in partial_rows)
        remaining_profit = sum(p["pred_profit_sek"]  for p in partial_rows)
        next_rev    = sum(p["pred_revenue_sek"] for p in next_rows)
        next_profit = sum(p["pred_profit_sek"]  for p in next_rows)
        next_units  = sum(p["pred_units"]        for p in next_rows)

        return {
            "year":                        year,
            "last_data_year":              last_data_year,
            "last_data_month":             last_data_month,
            "last_complete_year":          last_complete_year,
            "last_complete_month":         last_complete_month,
            "predictions":                 predictions,
            "predicted_year_revenue":      round(ytd_rev + remaining_rev),
            "predicted_year_profit":       round(ytd_profit + remaining_profit),
            "predicted_next_year_revenue": round(next_rev),
            "predicted_next_year_profit":  round(next_profit),
            "predicted_next_year_units":   round(next_units),
        }
    finally:
        conn.close()
