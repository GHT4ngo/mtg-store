{{ config(
    pre_hook="SET LOCAL work_mem = '128MB'",
    post_hook=[
        "CREATE INDEX IF NOT EXISTS silver_stock_scryfall_id ON {{ this }} (scryfall_id)",
        "CREATE INDEX IF NOT EXISTS silver_stock_reference   ON {{ this }} (reference)"
    ]
) }}

with

-- ── Scryfall lookup ──────────────────────────────────────────────────────────
-- MATERIALIZED: referenced by every match CTE below; upper_name computed once.
scryfall as MATERIALIZED (
    select
        scryfall_id,
        cardmarket_id,
        set_code,
        collector_number,
        name,
        upper(name)     as upper_name,
        foil,
        nonfoil,
        rarity,
        set_name,
        upper(set_name) as upper_set_name,
        image_url_normal,
        price_avg_sek,
        price_trend_sek,
        price_avg_foil_sek,
        price_trend_foil_sek,
        sell_price_sek,
        sell_price_foil_sek,
        price_date,
        eur_sek_rate
    from {{ ref('silver_cards') }}
),

-- ── Set-name fallback map ────────────────────────────────────────────────────
-- ~500 distinct rows; used in set_name_match to avoid LIKE scan of 91k rows.
set_name_map as (
    select distinct
        set_code,
        upper(left(set_name, 5)) as name_prefix5,
        upper(left(set_code, 3)) as code_prefix3
    from {{ ref('silver_cards') }}
),

-- ── Judge Gift set code map ───────────────────────────────────────────────────
-- LGS uses JYY prefixes for all judge years, but Scryfall diverged in 2021:
-- j21→pj21, j22→p22, j23→p23 (j22 collides with Jumpstart 2022 in Scryfall).
judge_set_map(alphaspel_code, scryfall_code) as (
    values ('j21','pj21'), ('j22','p22'), ('j23','p23'), ('j24','p24')
),

-- ── CN resolution: non-promo, non-token ─────────────────────────────────────
-- Three equality LEFT JOINs each use the (set_code, collector_number) index.
-- resolved_cn IS NULL → no reference match possible, falls through to name_match.
-- Exclude j21-j24 judge references: their set codes collide with Scryfall sets
-- (e.g. j22=Jumpstart 2022) and are handled by judge_ref_match instead.
ref_cn_resolved as (
    select
        sp.reference,
        coalesce(
            case when cn1.collector_number is not null then sp.collector_number_w_letter end,
            case when cn2.collector_number is not null then sp.collector_number_digits end,
            case when cn3.collector_number is not null then sp.collector_number_digits || 'a' end
        ) as resolved_cn
    from {{ ref('stock_parsed') }} sp
    left join {{ ref('silver_cards') }} cn1
        on cn1.set_code = sp.set_code
       and cn1.collector_number = sp.collector_number_w_letter
    left join {{ ref('silver_cards') }} cn2
        on cn2.set_code = sp.set_code
       and cn2.collector_number = sp.collector_number_digits
    left join {{ ref('silver_cards') }} cn3
        on cn3.set_code = sp.set_code
       and cn3.collector_number = sp.collector_number_digits || 'a'
    where sp.is_promo = false and sp.is_token = false
      and not (
          sp.set_code in ('j21','j22','j23','j24')
          and (sp.name ilike '%: Judge Promo%' or sp.name ilike '%: Judge Reward%' or sp.name ilike '%: Judge Gift%')
      )
),

-- ── CN resolution: promos ────────────────────────────────────────────────────
-- Promos live in set p<original-set>. Prerelease promos get a 's' suffix.
promo_cn_resolved as (
    select
        sp.reference,
        coalesce(
            case when cn1.collector_number is not null then sp.collector_number_digits || 's' end,
            case when cn2.collector_number is not null then sp.collector_number_digits end
        ) as resolved_cn
    from {{ ref('stock_parsed') }} sp
    left join {{ ref('silver_cards') }} cn1
        on cn1.set_code = 'p' || sp.set_code
       and cn1.collector_number = sp.collector_number_digits || 's'
    left join {{ ref('silver_cards') }} cn2
        on cn2.set_code = 'p' || sp.set_code
       and cn2.collector_number = sp.collector_number_digits
    where sp.is_promo = true
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 1 — Promo reference (third segment = 'P')
-- ════════════════════════════════════════════════════════════════════════════
promo_ref_match as (
    select
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        true                    as is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'promo_ref_match'       as match_type,
        'OK'                    as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join promo_cn_resolved pcn
        on pcn.reference = sp.reference and pcn.resolved_cn is not null
    inner join scryfall s
        on s.set_code = 'p' || sp.set_code
       and s.collector_number = pcn.resolved_cn
    where sp.is_promo = true
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 2 — Token reference (SET-TNNN or SET-T-NNN)
-- ════════════════════════════════════════════════════════════════════════════
token_ref_match as (
    select
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        null::text              as special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'token_ref_match'       as match_type,
        'OK'                    as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join scryfall s
        on s.set_code = 't' || (case sp.set_code when 'the' then 'ths' else sp.set_code end)
       and s.collector_number = sp.token_cn
    where sp.is_token = true
      and sp.token_cn is not null
      and sp.token_cn != ''
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 3 — Reference (exact set_code + collector_number)
-- ════════════════════════════════════════════════════════════════════════════
reference_match as (
    select
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'reference_match'       as match_type,
        'OK'                    as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join ref_cn_resolved rcn
        on rcn.reference = sp.reference and rcn.resolved_cn is not null
    inner join scryfall s
        on s.set_code = sp.set_code
       and s.collector_number = rcn.resolved_cn
    where sp.is_promo = false and sp.is_token = false
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 4 — Name (same set_code, but collector_number had no match)
-- ════════════════════════════════════════════════════════════════════════════
name_match as (
    select
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'name_match'            as match_type,
        case when sp.special_print like 'MYSTERY%' then 'MYSTERY_BOOSTER'
             else 'NAME_MATCH_PROMO' end as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join ref_cn_resolved rcn
        on rcn.reference = sp.reference and rcn.resolved_cn is null
    inner join scryfall s
        on s.set_code = sp.set_code
       and (s.upper_name = sp.parsed_name_upper
            or s.upper_name like sp.parsed_name_upper || ' //%')
    where sp.is_promo = false and sp.is_token = false
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 4b — Judge Gift reference (j21/j22/j23 → pj21/p22/p23)
-- Handles set code collisions where LGS JYY conflicts with Scryfall sets.
-- Matches by name since collector numbers may differ between systems.
-- ════════════════════════════════════════════════════════════════════════════
judge_ref_match as (
    select distinct on (sp.reference)
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'judge_ref_match'       as match_type,
        'OK'                    as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join judge_set_map jsm on jsm.alphaspel_code = sp.set_code
    inner join scryfall s
        on s.set_code = jsm.scryfall_code
       and (s.upper_name = sp.parsed_name_upper
            or s.upper_name like sp.parsed_name_upper || ' //%')
    where (sp.name ilike '%: Judge Promo%'
        or sp.name ilike '%: Judge Reward%'
        or sp.name ilike '%: Judge Gift%')
    order by sp.reference,
        s.price_trend_foil_sek desc nulls last
),

-- ── All early matches combined ───────────────────────────────────────────────
-- MATERIALIZED: referenced in 3 separate NOT EXISTS checks below.
all_early_matched as MATERIALIZED (
    select reference from reference_match
    union all select reference from name_match
    union all select reference from promo_ref_match
    union all select reference from token_ref_match
    union all select reference from judge_ref_match
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 5 — Set-name fallback (wrong set_code in LGS reference)
-- Uses set_name_map (~500 rows) so the join is ~1500×500 instead of ~1500×91k.
-- MATERIALIZED: referenced in 2 NOT EXISTS checks below.
-- ════════════════════════════════════════════════════════════════════════════
set_name_match as MATERIALIZED (
    select distinct on (sp.reference)
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'set_name_match'        as match_type,
        'NAME_MATCH_ASSUMED'    as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    -- Step 1: resolve set_name prefix → real set_code  (~1500 × 500 rows)
    inner join set_name_map snm
        on snm.name_prefix5 = sp.set_name_prefix5
        or snm.code_prefix3 = sp.set_code_prefix3
    -- Step 2: equality join to scryfall on resolved set_code + pre-computed name
    inner join scryfall s
        on s.set_code = snm.set_code
       and (s.upper_name = sp.parsed_name_upper
            or s.upper_name like sp.parsed_name_upper || ' //%')
    where not exists (select 1 from all_early_matched am where am.reference = sp.reference)
    -- Prefer base sets (no 'p' promo prefix), then highest-priced printing as tiebreaker
    order by sp.reference,
        (snm.set_code not like 'p%') desc nulls last,
        s.price_trend_sek desc nulls last
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 6 — Special print (MB/TL) by name + collector number
-- DISTINCT ON: prefers collector_number_w_letter over digits when both exist.
-- MATERIALIZED: referenced in mystery_list_name_match NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════
special_print_match as MATERIALIZED (
    select distinct on (sp.reference)
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'special_print_match'   as match_type,
        case sp.special_print
            when 'MYSTERY_BOOSTER'   then 'MYSTERY_BOOSTER'
            when 'MYSTERY_BOOSTER_2' then 'MYSTERY_BOOSTER'
            when 'THE_LIST'          then 'NAME_MATCH_PROMO'
            else 'NAME_MATCH_ASSUMED'
        end                     as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join scryfall s
        on s.upper_name = sp.parsed_name_upper
       and s.collector_number in (sp.collector_number_w_letter, sp.collector_number_digits)
    where sp.special_print is not null
      and not exists (select 1 from all_early_matched am  where am.reference  = sp.reference)
      and not exists (select 1 from set_name_match    snm where snm.reference = sp.reference)
    order by sp.reference,
        (s.collector_number = sp.collector_number_w_letter) desc nulls last
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 7 — Mystery Booster / The List: name-only fallback
-- Picks the highest price_trend_sek printing when CN matching fails.
-- ════════════════════════════════════════════════════════════════════════════
mystery_list_name_match as (
    select distinct on (sp.reference)
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'mystery_list_name_match' as match_type,
        case sp.special_print
            when 'MYSTERY_BOOSTER'   then 'MYSTERY_BOOSTER'
            when 'MYSTERY_BOOSTER_2' then 'MYSTERY_BOOSTER'
            when 'THE_LIST'          then 'NAME_MATCH_PROMO'
            else 'NAME_MATCH_ASSUMED'
        end                       as data_quality,
        s.name                    as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join scryfall s on s.upper_name = sp.parsed_name_upper
    where sp.special_print is not null
      and not exists (select 1 from special_print_match spm where spm.reference = sp.reference)
    order by sp.reference, s.price_trend_sek desc nulls last
),

-- ════════════════════════════════════════════════════════════════════════════
-- MATCH 8 — Keyword promo (Player Reward, GP Promo)
-- ════════════════════════════════════════════════════════════════════════════
promo_keyword_match as (
    select
        s.scryfall_id, s.cardmarket_id, s.set_code, s.collector_number, s.name, s.rarity,
        s.set_name, s.image_url_normal,
        s.price_avg_sek, s.price_trend_sek, s.price_avg_foil_sek, s.price_trend_foil_sek,
        s.sell_price_sek, s.sell_price_foil_sek, s.price_date, s.eur_sek_rate,
        sp.reference,
        sp.is_foil,
        sp.language,
        sp.special_foil_type,
        sp.condition,
        sp.condition_discount,
        sp.damaged,
        sp.stock_a, sp.stock_b, sp.stock_c, sp.total_stock,
        sp.reduction_percent, sp.reduction_start, sp.reduction_end,
        sp.sold_total, sp.sold_last_year, sp.long_description, sp.price_wt,
        sp.special_print,
        sp.is_signed,
        'promo_keyword_match'   as match_type,
        'NAME_MATCH_PROMO'      as data_quality,
        s.name                  as parsed_card_name
    from {{ ref('stock_parsed') }} sp
    inner join scryfall s
        on (
               (sp.name ilike '%Player Reward%' and s.set_name like 'Magic Player Rewards%')
            or (sp.name ilike '%GP Promo%'       and s.set_code = 'pgpx')
           )
       and (s.upper_name = sp.parsed_name_upper
            or s.upper_name like sp.parsed_name_upper || ' //%')
    where (sp.name ilike '%Player Reward%' or sp.name ilike '%GP Promo%')
      and not exists (select 1 from all_early_matched  am  where am.reference  = sp.reference)
      and not exists (select 1 from set_name_match     snm where snm.reference = sp.reference)
      and not exists (select 1 from special_print_match spm where spm.reference = sp.reference)
)

select * from reference_match
union all select * from name_match
union all select * from promo_ref_match
union all select * from token_ref_match
union all select * from judge_ref_match
union all select * from set_name_match
union all select * from special_print_match
union all select * from mystery_list_name_match
union all select * from promo_keyword_match
