with stock as (
    select * from {{ ref('silver_stock') }}
),

all_cards as (
    select * from {{ ref('silver_cards') }}
),

-- For double-faced tokens stored as two separate Scryfall cards on one physical card.
-- Handles two reference formats:
--   SET-T-NNN/MMM  (e.g. NCC-T-005/034)  — seg2='T', back CN is MMM in seg3
--   SET-TNNN/TMMM  (e.g. DFT-T01/T03)   — seg2='T01/T03', back CN is digits of second part
-- Include reference in output so the join in the final SELECT can be exact
-- (scryfall_id alone causes duplicates when multiple dual-face variants share a front face).
slash_token_back as (
    select
        s.scryfall_id,
        s.reference,
        bfc.name                as back_name,
        bfc.image_url_normal    as back_image_url
    from stock s
    join all_cards bfc
        on lower(bfc.set_code) = 't' || lower(
                case upper(split_part(s.reference, '-', 1))
                    when 'THE' then 'THS'
                    else split_part(s.reference, '-', 1)
                end
            )
       and bfc.collector_number = case
               -- SET-T-NNN/MMM: back CN is after the slash in seg3
               when upper(split_part(s.reference, '-', 2)) = 'T'
               then ltrim(split_part(split_part(split_part(s.reference, '-', 3), '/', 2), ':', 1), '0')
               -- SET-TNNN/TMMM: back CN is digits of the second T-segment
               else ltrim(substring(split_part(split_part(s.reference, '-', 2), '/', 2) from 2), '0')
           end
    where (
        -- SET-T-NNN/MMM format
        (upper(split_part(s.reference, '-', 2)) = 'T'
         and split_part(s.reference, '-', 3) like '%/%'
         and split_part(split_part(s.reference, '-', 3), '/', 2) != '')
        or
        -- SET-TNNN/TMMM format
        split_part(s.reference, '-', 2) ~ '^T[0-9]+/T[0-9]+$'
    )
)

select
    -- Identity
    c.scryfall_id,
    c.cardmarket_id,
    -- For slash double-faced tokens, combine both face names (e.g. "Elemental // Clue")
    coalesce(
        case when stb.back_name is not null then c.name || ' // ' || stb.back_name end,
        c.name
    )                           as name,
    c.set_code,
    c.set_name,
    c.collector_number,
    c.rarity,
    c.type_line,
    c.oracle_text,
    c.mana_cost,
    c.cmc,
    c.colors,
    c.color_identity,
    c.artist,
    c.image_url_normal,
    c.image_url_small,
    -- For slash DFT: use the back face image; otherwise card's own back URL
    coalesce(stb.back_image_url, c.image_url_back) as image_url_back,
    c.released_at,
    c.foil,
    c.nonfoil,
    c.full_art,
    c.promo,


    -- Prices
    c.price_avg_sek,
    c.price_trend_sek,
    c.price_avg_foil_sek,
    c.price_trend_foil_sek,
    c.price_avg_eur,
    c.price_low_eur,
    c.price_trend_eur,
    c.price_avg_foil_eur,
    c.price_trend_foil_eur,
    c.price_date,
    c.eur_sek_rate,

    -- LGS sell price calculations with condition-adjusted sell prices
       case when c.sell_price_sek is not null
            then greatest(
                (round(c.sell_price_sek * (1 - coalesce(s.condition_discount, 0)) / 5.0) * 5)::numeric,
                case when c.rarity in ('rare', 'mythic') then 10 else 5 end
            )
            else null
        end                                         as sell_price_sek,



    case when c.sell_price_foil_sek is not null
        then greatest(
            (round(c.sell_price_foil_sek * (1 - coalesce(s.condition_discount, 0)) / 5.0) * 5)::numeric,
            case when c.rarity in ('rare', 'mythic') then 10 else 5 end
        )
        else null
    end                                         as sell_price_foil_sek,

    -- Stock (null if not in MySQL system)
    s.reference,
    s.is_foil,
    coalesce(s.stock_a, 0)     as stock_a,
    coalesce(s.stock_b, 0)     as stock_b,
    coalesce(s.stock_c, 0)     as stock_c,
    coalesce(s.total_stock, 0) as total_stock,
    case when coalesce(s.total_stock, 0) > 0
        then true else false
    end                        as in_stock,
    s.match_type,

    s.condition,
    s.condition_discount,
    s.language,
    s.special_foil_type,
    s.damaged,
    s.sold_total,
    s.sold_last_year,
    s.long_description,
    s.price_wt,
    s.reduction_percent,
    s.reduction_start,
    s.reduction_end,
    s.special_print,
    s.is_signed,
    s.data_quality


from all_cards c
left join stock s
    on c.scryfall_id = s.scryfall_id
left join slash_token_back stb
    on stb.scryfall_id = c.scryfall_id
   and stb.reference  = s.reference