{{ config(materialized='table', schema='silver') }}

-- Date spine from 2015 (first order) to 2030
-- Used by analytics models to ensure no gaps in time series

with spine as (
    select generate_series(
        '2015-01-01'::date,
        '2030-12-31'::date,
        '1 day'::interval
    )::date as date_day
)

select
    date_day,
    to_char(date_day, 'YYYYMMDD')::int          as date_id,
    extract(year  from date_day)::int           as year,
    extract(month from date_day)::int           as month,
    extract(quarter from date_day)::int         as quarter,
    extract(week  from date_day)::int           as week_of_year,
    extract(dow   from date_day)::int           as day_of_week,   -- 0=Sun
    extract(day   from date_day)::int           as day_of_month,
    to_char(date_day, 'Mon YYYY')               as month_label,
    to_char(date_day, 'YYYY-MM')                as year_month,
    to_char(date_day, 'IYYY-IW')                as year_week,
    date_trunc('week',    date_day)::date       as week_start,
    date_trunc('month',   date_day)::date       as month_start,
    date_trunc('quarter', date_day)::date       as quarter_start,
    date_trunc('year',    date_day)::date       as year_start,
    (date_day = current_date)                   as is_today,
    (date_day <= current_date)                  as is_past_or_today

from spine
