{{ config(materialized='table', schema='gold') }}

/*
  gold_sales_daily
  ─────────────────
  Pre-aggregated sales metrics: one row per day × set_group × channel × game.
  Fast to query; no heavy aggregation at API time.
*/

select
    order_date,
    set_group,
    channel,
    game,

    -- Volume
    sum(quantity)                   as units_sold,
    count(distinct order_id)        as order_count,

    -- Revenue / cost / profit (already multiplied by qty in silver)
    sum(total_revenue_sek)          as revenue_sek,
    sum(total_cost_sek)             as cost_sek,
    sum(profit_sek)                 as profit_sek,

    -- Date helpers (copied from dim_date for convenience)
    date_trunc('week',  order_date)::date   as week_start,
    date_trunc('month', order_date)::date   as month_start,
    date_trunc('year',  order_date)::date   as year_start,
    extract(year  from order_date)::int     as order_year,
    extract(month from order_date)::int     as order_month

from {{ ref('silver_order_items') }}
group by 1, 2, 3, 4
