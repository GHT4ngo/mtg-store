{{ config(materialized='table', schema='silver') }}

/*
  silver_order_items
  ──────────────────
  Cleans and enriches bronze.order_items with:
  - Set name + set_code extracted from product name / sku
  - set_group via the same classify_set_group logic used in gold_cards
  - channel: in-store vs shipped
  - Revenue, cost, profit per line
  - Only DELIVERED or COMPLETE orders (excludes cancelled, waiting etc)
*/

with raw as (
    select *
    from bronze.order_items
    where order_status in ('delivered', 'complete', 'complete_reminder')
      and quantity > 0
),

-- Extract the set name from "Magic löskort: {Set Name}: {Card Name}"
parsed as (
    select
        id,
        order_id,
        product_id,
        sku,
        name,
        quantity,
        coalesce(price_wot, 0)::numeric        as revenue_sek,
        coalesce(wholesale_price, 0)::numeric  as cost_sek,
        order_status,
        is_instore,
        carrier_name,
        order_created_at,
        item_created_at,
        order_created_at::date                 as order_date,

        -- Set name: text between first and second ': '
        split_part(name, ': ', 2)              as set_name_raw,

        -- Card name: everything after second ': '
        -- Handle names with multiple colons (e.g. split cards)
        regexp_replace(name, '^[^:]+: [^:]+: ', '') as card_name_raw,

        -- SKU / reference for joining to silver_cards
        lower(trim(sku))                       as reference_lower,

        -- Game classification (MTG vs other card games)
        coalesce(game, 'MTG')                  as game

    from raw
),

-- Join to silver_stock to get canonical set_code and set_name via reference
enriched as (
    select
        p.*,
        coalesce(ss.set_code, lower(split_part(p.sku, '-', 1))) as set_code,
        coalesce(ss.set_name, p.set_name_raw)                   as set_name,
        ss.rarity

    from parsed p
    left join silver.silver_stock ss
        on lower(ss.reference) = p.reference_lower
        and ss.is_foil = (upper(p.sku) like '%%F' or upper(p.sku) like '%%PF')
),

-- Classify set into analytics groups (mirrors classify_set_group in api.py)
grouped as (
    select
        *,
        case
            -- Promos
            when set_code in ('fnm','dci','jr','j19','j20','pj21','p22','p23',
                              'mpr','pgpx','pcmp','pwor','gdy','pal',
                              'ppro','pwpn','pppr','plg20','plg21')
                 or (set_code like 'p%' and length(set_code) in (4,5))
                then 'Promos'
            -- Secret Lair
            when set_code like 'sl%' or set_code = 'slx'
                then 'Secret Lair'
            -- Commander
            when set_code in ('cmd','c13','c14','c15','c16','c17','c18','c19',
                              'c20','c21','cmr','afc','nec','clb','dmc','ltd',
                              'onc','mul','woc','clu','cmm','lcc','moc','otc',
                              'fdc','blc','dsc','fic')
                 or (set_code like '%c' and length(set_code) >= 4)
                then 'Commander'
            -- Masters & Reprints
            when set_code in ('mma','mm2','mm3','ema','ima','a25','uma','2xm',
                              '2x2','tsr','akr','klr','j21','mb1','mb2',
                              'cmb1','cmb2','plst','rvr','ltr','who','acr')
                then 'Masters & Reprint'
            -- Un-sets / Special
            when set_code in ('ust','unh','ugl','unf','und','hho','h17','h1r','plist')
                then 'Special / Un-sets'
            -- Classic (pre-2004)
            when set_code in ('lea','leb','2ed','3ed','4ed','5ed','6ed','7ed',
                              'arn','atq','leg','drk','fem','ice','all','hml',
                              'mir','vis','wth','tmp','sth','exo','usg','ulg',
                              'uds','mmq','nem','pcy','inv','pls','apc','ody',
                              'tor','jud','ons','lgn','scg','8ed','mrd','dst',
                              '5dn','chk','bok','sok','rav','gpt','dis','csp',
                              'tsp','plc','fut','fbb','4bb','sum','ren','rin')
                then 'Classic (pre-2004)'
            -- Modern
            when set_code in ('10e','lrw','mor','shm','eve','ala','con','arb',
                              'zen','wwk','roe','m10','m11','m12','m13','m14',
                              'm15','som','mbs','nph','isd','dka','avr','rtr',
                              'gtc','dgm','ths','bng','jou','ktk','frf','dtk',
                              'bfz','ogw','soi','emn','kld','aer','akh','hou',
                              'xln','rix','dom','m19','grn','rna','war','m20',
                              'eld','thb','iko','m21','znr','khm','stx','mh1',
                              'mh2','afr','mid','vow','neo','snc','dmu','bro',
                              'one','mom','mat','woe','lci','mkm','otj','blb',
                              'dsk','fdn','mh3','acr','dft','eoe','fin','inr')
                then 'Modern Sets'
            else 'Other'
        end                                              as set_group,

        -- Channel
        case
            when carrier_name ilike 'Avh%'
              or carrier_name ilike 'Till%'
              or is_instore = true
                then 'In-Store'
            else 'Shipped'
        end                                              as channel,

        -- Profit per line
        (revenue_sek - cost_sek) * quantity             as profit_sek,
        revenue_sek * quantity                          as total_revenue_sek,
        cost_sek    * quantity                          as total_cost_sek

    from enriched
)

select
    id,
    order_id,
    product_id,
    sku,
    name,
    card_name_raw                           as card_name,
    set_name,
    set_name_raw,
    set_code,
    set_group,
    rarity,
    quantity,
    revenue_sek,
    cost_sek,
    total_revenue_sek,
    total_cost_sek,
    profit_sek,
    game,
    channel,
    is_instore,
    carrier_name,
    order_status,
    order_date,
    order_created_at,
    item_created_at,
    -- Date parts for easy grouping
    extract(year  from order_date)::int     as order_year,
    extract(month from order_date)::int     as order_month,
    date_trunc('month', order_date)::date   as order_month_start,
    date_trunc('week',  order_date)::date   as order_week_start,
    date_trunc('year',  order_date)::date   as order_year_start

from grouped
