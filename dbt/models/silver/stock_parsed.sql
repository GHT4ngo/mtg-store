{{ config(
    post_hook=[
        "CREATE INDEX IF NOT EXISTS stock_parsed_ref     ON {{ this }} (reference)",
        "CREATE INDEX IF NOT EXISTS stock_parsed_setcn1  ON {{ this }} (set_code, collector_number_w_letter)",
        "CREATE INDEX IF NOT EXISTS stock_parsed_setcn2  ON {{ this }} (set_code, collector_number_digits)",
        "CREATE INDEX IF NOT EXISTS stock_parsed_name    ON {{ this }} (parsed_name_upper)"
    ]
) }}

-- Step 1: raw extract + pre-split the three most-used segments so
-- every downstream column can reference a simple identifier instead
-- of repeating split_part(reference, '-', N) multiple times.
with base as (
    select
        reference,
        name,
        stock_a,
        stock_b,
        stock_c,
        total_stock,
        condition,
        damaged,
        reduction_percent,
        reduction_start,
        reduction_end,
        sold_total,
        sold_last_year,
        long_description,
        price_wt,
        loaded_date,

        lower(split_part(reference, '-', 1))          as set_code,
        split_part(reference, '-', 2)                 as seg2,   -- e.g. "214F", "T06", "T"
        split_part(reference, '-', 3)                 as seg3    -- e.g. "P", "1", ""

    from bronze.mysql_stock
    where loaded_date = (select max(loaded_date) from bronze.mysql_stock)
      and reference is not null
      and reference != ''
      and is_active = 1
      and upper(split_part(reference, '-', 2)) not like 'CH%'
),

-- Step 2: compute the cleaned seg2 once for both CN columns
mid as (
    select
        *,
        -- Strip slash variant, strip colon suffix (e.g. "083u:1" → "083u"), then strip trailing foil-F
        regexp_replace(upper(split_part(split_part(seg2, '/', 1), ':', 1)), 'F$', '') as seg2_cn,
        (split_part(seg3, ':', 1) = 'P')                          as is_promo
    from base
)

select
    -- ── Stock data ────────────────────────────────────────────────
    reference,
    name,
    stock_a,
    stock_b,
    stock_c,
    total_stock,
    condition,
    damaged,
    reduction_percent,
    reduction_start,
    reduction_end,
    sold_total,
    sold_last_year,
    long_description,
    price_wt,
    loaded_date,

    -- ── Parsed reference fields (computed once, indexed) ──────────
    set_code,

    -- Collector number keeping trailing letter (e.g. "214a" for old sets like FEM)
    ltrim(regexp_replace(lower(seg2_cn), '[^0-9a-z]', '', 'g'), '0')  as collector_number_w_letter,

    -- Collector number digits only (e.g. "214")
    ltrim(regexp_replace(seg2_cn, '[^0-9]', '', 'g'), '0')             as collector_number_digits,

    -- ── Boolean flags ─────────────────────────────────────────────
    is_promo,

    (seg2 ~ '^T[0-9]+$'
     or (upper(seg2) = 'T' and seg3 ~ '^[0-9]')
     or seg2 ~ '^T[0-9]+/T[0-9]+$')                                    as is_token,

    -- Token CN: front-face number only; strip leading zeros
    case
        when upper(seg2) = 'T' and seg3 ~ '^[0-9]'
        then ltrim(split_part(seg3, '/', 1), '0')                      -- SET-T-NNN format
        when seg2 ~ '^T[0-9]+/T[0-9]+$'
        then ltrim(substring(split_part(seg2, '/', 1) from 2), '0')   -- SET-TNNN/TMMM dual-face token
        else ltrim(substring(split_part(seg2, ':', 1) from 2), '0')   -- SET-TNNN format
    end                                                                as token_cn,

    -- Foil: reference ends with F, is a promo, MySQL name contains "Foil",
    -- or the product category is a judge reward/promo set (always foil-only)
    (upper(trim(reference)) ~ '[-]?[A-Z0-9]*F$'
     or is_promo
     or name ilike '%Foil%'
     or split_part(name, ': ', 2) ilike 'Judge Promo%'
     or split_part(name, ': ', 2) ilike 'Judge Reward%'
     or split_part(name, ': ', 2) ilike 'Judge Gift%'
    ) as is_foil,

    -- ── Descriptive fields ────────────────────────────────────────
    case
        when name ~* '\((Fransk|Tysk|Italiensk|Spansk|Koreansk|Japansk|Kinesisk|Rysk)\)'
        then regexp_replace(
                name,
                '.*\((Fransk|Tysk|Italiensk|Spansk|Koreansk|Japansk|Kinesisk|Rysk)\).*',
                '\1', 'i'
             )
        else 'English'
    end                                                                as language,

    case
        when name ~* '\(Prerelease[[:space:]]?Foil\)'  then 'Prerelease Foil'
        when name ~* '\(Release[[:space:]]?Foil\)'     then 'Release Foil'
        when name ~* '\(Silver[[:space:]]?Foil\)'      then 'Silver Foil'
        when name ~* '\(Etched[[:space:]]?Foil\)'      then 'Etched Foil'
        when is_promo and name ~* '\(Prerelease\)'     then 'Prerelease Foil'
        when is_promo                                  then 'Promo Foil'
        else null
    end                                                                as special_foil_type,

    case
        when set_code like 'mb2%' then 'MYSTERY_BOOSTER_2'
        when set_code like 'mb%'  then 'MYSTERY_BOOSTER'
        when set_code like 'tl%'  then 'THE_LIST'
        else null
    end                                                                as special_print,

    (name ilike '%Signed%' or name ilike '%Signerad%')                 as is_signed,

    -- ── Card name (indexed, used for name-based matching) ─────────
    -- Strip "Magic löskort: SetName: " prefix and trailing parentheticals
    upper(trim(regexp_replace(
        regexp_replace(name, '^[^:]+: [^:]+: ', ''),
        '\s*\([^)]+\)\s*$', '', 'g'
    )))                                                                as parsed_name_upper,

    -- Set name prefix helpers for set_name_match fallback
    upper(left(split_part(name, ': ', 2), 5))                          as set_name_prefix5,
    upper(left(split_part(name, ': ', 2), 3))                          as set_code_prefix3,

    -- ── Condition discount ────────────────────────────────────────
    case condition
        when 'MT' then 0.00
        when 'NM' then 0.00
        when 'VF' then 0.10
        when 'FN' then 0.10
        when 'VG' then 0.10
        when 'GD' then 0.15
        when 'FR' then 0.20
        when 'PR' then 0.25
        else          0.00
    end                                                                as condition_discount

from mid
