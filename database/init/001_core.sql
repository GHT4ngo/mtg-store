CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS bronze;
CREATE SCHEMA IF NOT EXISTS silver;
CREATE SCHEMA IF NOT EXISTS gold;

CREATE TABLE IF NOT EXISTS bronze.scryfall_cards (
    scryfall_id UUID PRIMARY KEY,
    cardmarket_id BIGINT,
    raw_data JSONB NOT NULL,
    loaded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bronze.cardmarket_prices (
    idproduct BIGINT,
    avg NUMERIC,
    low NUMERIC,
    trend NUMERIC,
    avg1 NUMERIC,
    avg7 NUMERIC,
    avg30 NUMERIC,
    avg_foil NUMERIC,
    low_foil NUMERIC,
    trend_foil NUMERIC,
    avg1_foil NUMERIC,
    avg7_foil NUMERIC,
    avg30_foil NUMERIC,
    loaded_date DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS cardmarket_prices_product_date
    ON bronze.cardmarket_prices (idproduct, loaded_date);

CREATE TABLE IF NOT EXISTS bronze.exchange_rates (
    series_id TEXT NOT NULL,
    rate_date DATE NOT NULL,
    rate_value NUMERIC NOT NULL,
    loaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (series_id, rate_date)
);

CREATE TABLE IF NOT EXISTS bronze.mysql_stock (
    reference TEXT NOT NULL,
    name TEXT,
    stock_a INTEGER NOT NULL DEFAULT 0,
    stock_b INTEGER NOT NULL DEFAULT 0,
    stock_c INTEGER NOT NULL DEFAULT 0,
    condition TEXT,
    damaged INTEGER NOT NULL DEFAULT 0,
    reduction_percent NUMERIC,
    reduction_start TIMESTAMP,
    reduction_end TIMESTAMP,
    sold_total INTEGER,
    sold_last_year INTEGER,
    long_description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    price_wt NUMERIC,
    loaded_date DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS mysql_stock_reference_date
    ON bronze.mysql_stock (reference, loaded_date);

CREATE TABLE IF NOT EXISTS bronze.order_items (
    id BIGINT PRIMARY KEY,
    order_id INTEGER,
    product_id INTEGER,
    sku VARCHAR(128),
    name VARCHAR(256),
    quantity INTEGER,
    price_wot NUMERIC(12,2),
    wholesale_price NUMERIC(12,2),
    order_status VARCHAR(100),
    is_instore BOOLEAN,
    carrier_name VARCHAR(128),
    order_created_at TIMESTAMP,
    item_created_at TIMESTAMP,
    game VARCHAR(50) DEFAULT 'MTG',
    ingested_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bronze.stock_delta (
    reference TEXT NOT NULL,
    condition TEXT NOT NULL,
    stock_a INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    source TEXT,
    card_name TEXT,
    changed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reference, condition)
);

CREATE TABLE IF NOT EXISTS bronze.reference_corrections (
    reference TEXT PRIMARY KEY,
    set_code TEXT NOT NULL,
    collector_number TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bronze.price_overrides (
    set_code TEXT NOT NULL,
    collector_number TEXT NOT NULL,
    is_foil BOOLEAN NOT NULL DEFAULT FALSE,
    price_sek NUMERIC NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (set_code, collector_number, is_foil)
);

CREATE OR REPLACE FUNCTION calculate_sell_price(
    price_eur NUMERIC,
    rarity TEXT,
    eur_sek_rate NUMERIC,
    sold_last_year NUMERIC DEFAULT 0
) RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    multiplier NUMERIC;
    minimum_sek NUMERIC;
    result_sek NUMERIC;
BEGIN
    IF price_eur IS NULL OR price_eur <= 0 THEN
        RETURN NULL;
    END IF;

    multiplier := CASE
        WHEN price_eur < 0.25 THEN 1.74
        WHEN price_eur < 0.50 THEN 3.48
        WHEN price_eur < 1.00 THEN 2.61
        WHEN price_eur < 5.00 THEN 1.74
        WHEN price_eur < 10.00 THEN 1.65
        WHEN price_eur < 20.00 THEN 1.57
        WHEN price_eur < 50.00 THEN 1.46
        WHEN price_eur < 100.00 THEN 1.30
        WHEN price_eur < 500.00 THEN 1.20
        ELSE 1.10
    END;

    minimum_sek := CASE
        WHEN rarity IN ('rare', 'mythic') AND sold_last_year > 1 THEN 15
        WHEN rarity IN ('rare', 'mythic') THEN 10
        ELSE 5
    END;

    result_sek := GREATEST(price_eur * COALESCE(eur_sek_rate, 11.5) * multiplier, minimum_sek);
    RETURN ROUND(result_sek / 5) * 5;
END;
$$;
