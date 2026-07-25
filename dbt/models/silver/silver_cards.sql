{{ config(
    post_hook=[
        "CREATE INDEX IF NOT EXISTS silver_cards_scryfall_id      ON {{ this }} (scryfall_id)",
        "CREATE INDEX IF NOT EXISTS silver_cards_set_collector     ON {{ this }} (set_code, collector_number)",
        "CREATE INDEX IF NOT EXISTS silver_cards_cardmarket_id     ON {{ this }} (cardmarket_id)"
    ]
) }}

with scryfall as (
    select
        scryfall_id,
        cardmarket_id,
        raw_data->>'name'                   as name,
        raw_data->>'lang'                   as lang,
        raw_data->>'set'                    as set_code,
        raw_data->>'set_name'               as set_name,
        raw_data->>'collector_number'       as collector_number,
        raw_data->>'rarity'                 as rarity,
        raw_data->>'type_line'              as type_line,
        raw_data->>'oracle_text'            as oracle_text,
        raw_data->>'mana_cost'              as mana_cost,
        raw_data->>'cmc'                    as cmc,
        raw_data->>'colors'                 as colors,
        raw_data->>'color_identity'         as color_identity,
        raw_data->>'artist'                 as artist,
        raw_data->>'border_color'           as border_color,
        raw_data->>'frame'                  as frame,
        (raw_data->>'foil')::boolean        as foil,
        (raw_data->>'nonfoil')::boolean     as nonfoil,
        (raw_data->>'full_art')::boolean    as full_art,
        (raw_data->>'promo')::boolean       as promo,
        (raw_data->>'digital')::boolean     as digital,
        (raw_data->>'reprint')::boolean     as reprint,
        raw_data->>'released_at'               as released_at,
        coalesce(
            raw_data->'image_uris'->>'normal',
            raw_data->'card_faces'->0->'image_uris'->>'normal'
        )                                                   as image_url_normal,
        coalesce(
            raw_data->'image_uris'->>'small',
            raw_data->'card_faces'->0->'image_uris'->>'small'
        )                                                   as image_url_small,
        raw_data->'card_faces'->1->'image_uris'->>'normal'  as image_url_back,
        loaded_at,
        -- Scryfall native prices as fallback when Cardmarket has no data
        (raw_data->'prices'->>'eur')::numeric       as sc_price_eur,
        (raw_data->'prices'->>'eur_foil')::numeric  as sc_price_foil_eur,
        (raw_data->'prices'->>'usd')::numeric       as sc_price_usd,
        (raw_data->'prices'->>'usd_foil')::numeric  as sc_price_foil_usd
    from bronze.scryfall_cards
    where cardmarket_id is not null
),

prices as (
    select
        idproduct,
        avg,
        low,
        trend,
        avg7,
        avg30,
        avg_foil,
        low_foil,
        trend_foil,
        loaded_date
    from bronze.cardmarket_prices
    -- only the most recent price load
    where loaded_date = (select max(loaded_date) from bronze.cardmarket_prices)
),

exchange as (
    select
        series_id,
        rate_value
    from bronze.exchange_rates er
    where rate_date = (
        select max(rate_date)
        from bronze.exchange_rates
        where series_id = er.series_id
    )
),

eur_to_sek as (
    select rate_value as rate
    from exchange
    where series_id = 'EUR/SEK'
),

usd_to_sek as (
    select rate_value as rate
    from exchange
    where series_id = 'USD/SEK'
),

-- Pre-compute the set of token set codes we actually have in stock.
-- e.g. '10E-T06' → 't10e'. Done once as a small set before the main token join.
token_sets_in_stock as (
    select distinct
        't' || lower(split_part(reference, '-', 1)) as token_set_code
    from bronze.mysql_stock
    where loaded_date = (select max(loaded_date) from bronze.mysql_stock)
      and is_active = 1
      and upper(split_part(reference, '-', 2)) like 'T%'
      and reference is not null
),

-- Regular cards with no Cardmarket ID (e.g. meld pieces, some promos) that exist
-- in sets we actually stock. Scoped by stocked set codes to avoid bloat.
-- EUR/USD prices from Scryfall native price fields as fallback.
no_cm_regular_sets as (
    select distinct lower(split_part(reference, '-', 1)) as set_code
    from bronze.mysql_stock
    where loaded_date = (select max(loaded_date) from bronze.mysql_stock)
      and is_active = 1
),

no_cm_regular_cards as (
    select
        sc.scryfall_id,
        null::integer                                   as cardmarket_id,
        raw_data->>'name'                               as name,
        raw_data->>'lang'                               as lang,
        raw_data->>'set'                                as set_code,
        raw_data->>'set_name'                           as set_name,
        raw_data->>'collector_number'                   as collector_number,
        raw_data->>'rarity'                             as rarity,
        raw_data->>'type_line'                          as type_line,
        raw_data->>'oracle_text'                        as oracle_text,
        raw_data->>'mana_cost'                          as mana_cost,
        raw_data->>'cmc'                                as cmc,
        raw_data->>'colors'                             as colors,
        raw_data->>'color_identity'                     as color_identity,
        raw_data->>'artist'                             as artist,
        (raw_data->>'foil')::boolean                    as foil,
        (raw_data->>'nonfoil')::boolean                 as nonfoil,
        (raw_data->>'full_art')::boolean                as full_art,
        (raw_data->>'promo')::boolean                   as promo,
        (raw_data->>'digital')::boolean                 as digital,
        (raw_data->>'reprint')::boolean                 as reprint,
        raw_data->>'released_at'                        as released_at,
        coalesce(
            raw_data->'image_uris'->>'normal',
            raw_data->'card_faces'->0->'image_uris'->>'normal'
        )                                               as image_url_normal,
        coalesce(
            raw_data->'image_uris'->>'small',
            raw_data->'card_faces'->0->'image_uris'->>'small'
        )                                               as image_url_small,
        raw_data->'card_faces'->1->'image_uris'->>'normal' as image_url_back,
        sc.loaded_at,
        coalesce(
            (raw_data->'prices'->>'eur')::numeric,
            (raw_data->'prices'->>'usd')::numeric * u.rate / e.rate
        )                                               as native_price_eur,
        coalesce(
            (raw_data->'prices'->>'eur_foil')::numeric,
            (raw_data->'prices'->>'usd_foil')::numeric * u.rate / e.rate
        )                                               as native_price_foil_eur
    from bronze.scryfall_cards sc
    inner join no_cm_regular_sets ns on ns.set_code = raw_data->>'set'
    cross join eur_to_sek e
    cross join usd_to_sek u
    where sc.cardmarket_id is null
      and raw_data->>'lang' = 'en'
      and substring(raw_data->>'set', 1, 1) != 't'   -- token sets handled separately
),

-- Token cards: no Cardmarket ID, priced from Scryfall's own price fields.
-- Only loads tokens for sets where we have stock. EUR preferred, USD fallback.
token_cards as (
    select
        sc.scryfall_id,
        null::integer                                   as cardmarket_id,
        raw_data->>'name'                               as name,
        raw_data->>'lang'                               as lang,
        raw_data->>'set'                                as set_code,
        raw_data->>'set_name'                           as set_name,
        raw_data->>'collector_number'                   as collector_number,
        coalesce(raw_data->>'rarity', 'common')         as rarity,
        raw_data->>'type_line'                          as type_line,
        raw_data->>'oracle_text'                        as oracle_text,
        raw_data->>'mana_cost'                          as mana_cost,
        raw_data->>'cmc'                                as cmc,
        raw_data->>'colors'                             as colors,
        raw_data->>'color_identity'                     as color_identity,
        raw_data->>'artist'                             as artist,
        (raw_data->>'foil')::boolean                    as foil,
        (raw_data->>'nonfoil')::boolean                 as nonfoil,
        (raw_data->>'full_art')::boolean                as full_art,
        (raw_data->>'promo')::boolean                   as promo,
        (raw_data->>'digital')::boolean                 as digital,
        (raw_data->>'reprint')::boolean                 as reprint,
        raw_data->>'released_at'                        as released_at,
        coalesce(
            raw_data->'image_uris'->>'normal',
            raw_data->'card_faces'->0->'image_uris'->>'normal'
        )                                               as image_url_normal,
        coalesce(
            raw_data->'image_uris'->>'small',
            raw_data->'card_faces'->0->'image_uris'->>'small'
        )                                               as image_url_small,
        raw_data->'card_faces'->1->'image_uris'->>'normal' as image_url_back,
        sc.loaded_at,
        coalesce(
            (raw_data->'prices'->>'eur')::numeric,
            (raw_data->'prices'->>'usd')::numeric * u.rate / e.rate
        )                                               as token_price_eur,
        coalesce(
            (raw_data->'prices'->>'eur_foil')::numeric,
            (raw_data->'prices'->>'usd_foil')::numeric * u.rate / e.rate
        )                                               as token_price_foil_eur
    from bronze.scryfall_cards sc
    inner join token_sets_in_stock ts
        on ts.token_set_code = raw_data->>'set'
    cross join eur_to_sek e
    cross join usd_to_sek u
    where sc.cardmarket_id is null
)

select
    s.scryfall_id,
    s.cardmarket_id,
    s.name,
    s.lang,
    s.set_code,
    s.set_name,
    s.collector_number,
    s.rarity,
    s.type_line,
    s.oracle_text,
    s.mana_cost,
    s.cmc::numeric                              as cmc,
    s.colors,
    s.color_identity,
    s.artist,
    s.foil,
    s.nonfoil,
    s.full_art,
    s.promo,
    s.digital,
    s.reprint,
    s.image_url_normal,
    s.image_url_small,
    s.image_url_back,
    s.released_at::date                         as released_at,

    -- Prices in EUR: Cardmarket preferred (zeros treated as missing), Scryfall EUR fallback, Scryfall USD converted last
    coalesce(nullif(p.avg,        0), s.sc_price_eur,      s.sc_price_usd      * u.rate / x.rate) as price_avg_eur,
    coalesce(nullif(p.low,        0), s.sc_price_eur,      s.sc_price_usd      * u.rate / x.rate) as price_low_eur,
    coalesce(nullif(p.trend,      0), s.sc_price_eur,      s.sc_price_usd      * u.rate / x.rate) as price_trend_eur,
    p.avg7                                      as price_avg7_eur,
    p.avg30                                     as price_avg30_eur,
    coalesce(nullif(p.avg_foil,   0), s.sc_price_foil_eur, s.sc_price_foil_usd * u.rate / x.rate) as price_avg_foil_eur,
    coalesce(nullif(p.low_foil,   0), s.sc_price_foil_eur, s.sc_price_foil_usd * u.rate / x.rate) as price_low_foil_eur,
    coalesce(nullif(p.trend_foil, 0), s.sc_price_foil_eur, s.sc_price_foil_usd * u.rate / x.rate) as price_trend_foil_eur,

    -- Prices converted to SEK
    round(coalesce(nullif(p.avg,        0), s.sc_price_eur,      s.sc_price_usd      * u.rate / x.rate) * x.rate, 2) as price_avg_sek,
    round(coalesce(nullif(p.low,        0), s.sc_price_eur,      s.sc_price_usd      * u.rate / x.rate) * x.rate, 2) as price_low_sek,
    round(coalesce(nullif(p.trend,      0), s.sc_price_eur,      s.sc_price_usd      * u.rate / x.rate) * x.rate, 2) as price_trend_sek,
    round(coalesce(nullif(p.avg_foil,   0), s.sc_price_foil_eur, s.sc_price_foil_usd * u.rate / x.rate) * x.rate, 2) as price_avg_foil_sek,
    round(coalesce(nullif(p.trend_foil, 0), s.sc_price_foil_eur, s.sc_price_foil_usd * u.rate / x.rate) * x.rate, 2) as price_trend_foil_sek,

    -- LGS Prices
    calculate_sell_price(coalesce(nullif(p.trend,      0), s.sc_price_eur,      s.sc_price_usd      * u.rate / x.rate), s.rarity, x.rate, 0) as sell_price_sek,
    calculate_sell_price(coalesce(nullif(p.trend_foil, 0), s.sc_price_foil_eur, s.sc_price_foil_usd * u.rate / x.rate), s.rarity, x.rate, 0) as sell_price_foil_sek,

    p.loaded_date                               as price_date,
    x.rate                                      as eur_sek_rate

from scryfall s
left join prices p
    on s.cardmarket_id = p.idproduct
cross join eur_to_sek x
cross join usd_to_sek u

union all

select
    t.scryfall_id,
    t.cardmarket_id,
    t.name,
    t.lang,
    t.set_code,
    t.set_name,
    t.collector_number,
    t.rarity,
    t.type_line,
    t.oracle_text,
    t.mana_cost,
    t.cmc::numeric                                  as cmc,
    t.colors,
    t.color_identity,
    t.artist,
    t.foil,
    t.nonfoil,
    t.full_art,
    t.promo,
    t.digital,
    t.reprint,
    t.image_url_normal,
    t.image_url_small,
    t.image_url_back,
    t.released_at::date                             as released_at,
    -- All EUR price fields from Scryfall native price (no trend/avg7/avg30 available)
    t.token_price_eur                               as price_avg_eur,
    t.token_price_eur                               as price_low_eur,
    t.token_price_eur                               as price_trend_eur,
    null::numeric                                   as price_avg7_eur,
    null::numeric                                   as price_avg30_eur,
    t.token_price_foil_eur                          as price_avg_foil_eur,
    t.token_price_foil_eur                          as price_low_foil_eur,
    t.token_price_foil_eur                          as price_trend_foil_eur,
    round(t.token_price_eur * x.rate, 2)            as price_avg_sek,
    round(t.token_price_eur * x.rate, 2)            as price_low_sek,
    round(t.token_price_eur * x.rate, 2)            as price_trend_sek,
    round(t.token_price_foil_eur * x.rate, 2)       as price_avg_foil_sek,
    round(t.token_price_foil_eur * x.rate, 2)       as price_trend_foil_sek,
    calculate_sell_price(t.token_price_eur, t.rarity, x.rate, 0)      as sell_price_sek,
    calculate_sell_price(t.token_price_foil_eur, t.rarity, x.rate, 0) as sell_price_foil_sek,
    (select max(loaded_date) from bronze.cardmarket_prices)             as price_date,
    x.rate                                          as eur_sek_rate

from token_cards t
cross join eur_to_sek x

union all

select
    n.scryfall_id,
    n.cardmarket_id,
    n.name,
    n.lang,
    n.set_code,
    n.set_name,
    n.collector_number,
    n.rarity,
    n.type_line,
    n.oracle_text,
    n.mana_cost,
    n.cmc::numeric                                  as cmc,
    n.colors,
    n.color_identity,
    n.artist,
    n.foil,
    n.nonfoil,
    n.full_art,
    n.promo,
    n.digital,
    n.reprint,
    n.image_url_normal,
    n.image_url_small,
    n.image_url_back,
    n.released_at::date                             as released_at,
    n.native_price_eur                              as price_avg_eur,
    n.native_price_eur                              as price_low_eur,
    n.native_price_eur                              as price_trend_eur,
    null::numeric                                   as price_avg7_eur,
    null::numeric                                   as price_avg30_eur,
    n.native_price_foil_eur                         as price_avg_foil_eur,
    n.native_price_foil_eur                         as price_low_foil_eur,
    n.native_price_foil_eur                         as price_trend_foil_eur,
    round(n.native_price_eur * x.rate, 2)           as price_avg_sek,
    round(n.native_price_eur * x.rate, 2)           as price_low_sek,
    round(n.native_price_eur * x.rate, 2)           as price_trend_sek,
    round(n.native_price_foil_eur * x.rate, 2)      as price_avg_foil_sek,
    round(n.native_price_foil_eur * x.rate, 2)      as price_trend_foil_sek,
    calculate_sell_price(n.native_price_eur, n.rarity, x.rate, 0)      as sell_price_sek,
    calculate_sell_price(n.native_price_foil_eur, n.rarity, x.rate, 0) as sell_price_foil_sek,
    (select max(loaded_date) from bronze.cardmarket_prices)             as price_date,
    x.rate                                          as eur_sek_rate

from no_cm_regular_cards n
cross join eur_to_sek x