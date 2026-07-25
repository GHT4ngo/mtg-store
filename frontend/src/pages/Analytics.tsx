import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LabelList,
} from "recharts";
import StoreHeader from "@/components/StoreHeader";
import {
  fetchAnalyticsSummary,
  fetchAnalyticsOverTime,
  fetchAnalyticsBySetCode,
  fetchAnalyticsByChannel,
  fetchAnalyticsYears,
  fetchAnalyticsPredictions,
  type AnalyticsKpiRow,
  type AnalyticsSetCode,
  type AnalyticsPredictions,
} from "@/lib/api";

// ─── Colours ──────────────────────────────────────────────────────────────────

const CHANNEL_COLORS = ["hsl(215 70% 55%)", "hsl(145 60% 45%)"];
const COLOR_MTG      = "hsl(43 80% 55%)";
const COLOR_OTHER    = "hsl(280 60% 60%)";
const COLOR_PRED_REV = "hsl(0 70% 58%)";
const COLOR_PRED_PRF = "hsl(15 65% 52%)";

const SET_PALETTE = [
  "hsl(215 70% 60%)", "hsl(145 60% 50%)", "hsl(43 80% 58%)",
  "hsl(0 65% 58%)",   "hsl(280 60% 63%)", "hsl(180 55% 50%)",
  "hsl(330 60% 58%)", "hsl(25 75% 58%)",  "hsl(90 55% 50%)",
  "hsl(200 65% 55%)", "hsl(350 60% 58%)", "hsl(160 55% 47%)",
  "hsl(55 75% 53%)",  "hsl(240 60% 63%)", "hsl(15 70% 55%)",
  "hsl(120 50% 48%)", "hsl(300 55% 58%)", "hsl(70 65% 51%)",
  "hsl(190 60% 51%)", "hsl(270 55% 61%)",
];

// ─── Shared tooltip style ─────────────────────────────────────────────────────

const TT_STYLE: React.CSSProperties = {
  background:   "rgba(10, 12, 20, 0.93)",
  border:       "1px solid rgba(255,255,255,0.09)",
  borderRadius: "8px",
  fontSize:     12,
  color:        "#e2e8f0",
  boxShadow:    "0 8px 32px rgba(0,0,0,0.6)",
};
const TT_LABEL:  React.CSSProperties = { color: "#94a3b8", marginBottom: 4 };
const TT_ITEM:   React.CSSProperties = { color: "#e2e8f0" };
const TT_CURSOR: React.CSSProperties = { fill: "rgba(255,255,255,0.03)" } as any;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number)    { return new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 }).format(n); }
function fmtSek(n: number) { return `${fmt(n)} kr`; }
function pct(part: number, total: number) {
  if (!total) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

// ─── Custom tooltip for set code bars ─────────────────────────────────────────

function SetCodeTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as AnalyticsSetCode;
  const code = (d.set_prefix || "").toLowerCase();
  return (
    <div style={{ ...TT_STYLE, padding: "10px 14px", minWidth: 190 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <img
          src={`https://c2.scryfall.com/file/scryfall-symbols/sets/${code}.svg`}
          alt={code}
          width={20} height={20}
          style={{ filter: "invert(0.85)" }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
        <div>
          <div style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 13 }}>{d.display_name}</div>
          <div style={{ color: "#475569", fontSize: 10, fontFamily: "monospace", letterSpacing: "0.05em" }}>
            {d.set_prefix}
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "3px 16px" }}>
        {[
          ["Revenue",  fmtSek(d.revenue_sek)],
          ["Profit",   fmtSek(d.profit_sek)],
          ["Units",    fmt(d.units_sold)],
        ].map(([label, value]) => (
          <>
            <span key={`l-${label}`} style={{ color: "#64748b", fontSize: 10 }}>{label}</span>
            <span key={`v-${label}`} style={{ color: "#e2e8f0", textAlign: "right" }}>{value}</span>
          </>
        ))}
      </div>
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiBlockProps {
  row: AnalyticsKpiRow;
  isCenter?: boolean;
  predictedRevenue?: number;
  predictedProfit?: number;
  predictedUnits?: number;
}

function KpiBlock({ row, isCenter, predictedRevenue, predictedProfit, predictedUnits }: KpiBlockProps) {
  const yearLabel   = row.year ? String(Math.round(row.year)) : "–";
  const isPartial   = !!row.is_partial || (predictedRevenue != null && predictedRevenue > row.revenue_sek);
  // Use historical-average prediction if available; fall back to linear
  const fullRevenue = predictedRevenue ?? row.projected_revenue_sek;
  const fullProfit  = predictedProfit  ?? row.projected_profit_sek;
  const fullUnits   = predictedUnits   ?? row.projected_units_sold;
  const marginPct   = row.revenue_sek > 0
    ? ((row.profit_sek / row.revenue_sek) * 100).toFixed(1)
    : "0.0";

  return (
    <div
      className={`rounded-xl border p-5 flex flex-col gap-3 ${isCenter ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}
      style={isCenter ? { boxShadow: "0 0 30px rgba(99,102,241,0.12)" } : undefined}
    >
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-bold tracking-tight ${isCenter ? "text-primary" : "text-foreground/60"}`}>
          {yearLabel}
        </span>
        {isPartial && (
          <span className="text-[10px] text-amber-400/80 border border-amber-400/30 rounded px-1.5 py-0.5 font-medium">
            YTD · projected
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">Revenue</div>
          <div className="text-base font-bold text-foreground">{fmtSek(row.revenue_sek)}</div>
          {fullRevenue != null && fullRevenue > row.revenue_sek && (
            <div className="text-xs text-amber-400/70 mt-0.5">~{fmtSek(fullRevenue)} full year</div>
          )}
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">Profit</div>
          <div className="text-base font-bold text-foreground">{fmtSek(row.profit_sek)}</div>
          {fullProfit != null && fullProfit > row.profit_sek && (
            <div className="text-xs text-amber-400/70 mt-0.5">~{fmtSek(fullProfit)} full year</div>
          )}
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">Units</div>
          <div className="text-sm font-semibold text-foreground">{fmt(row.units_sold)}</div>
          {fullUnits != null && fullUnits > row.units_sold && (
            <div className="text-xs text-amber-400/70 mt-0.5">~{fmt(fullUnits)} full year</div>
          )}
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">Margin</div>
          <div className="text-sm font-semibold text-foreground">{marginPct}%</div>
        </div>
      </div>
    </div>
  );
}

function AllTimeKpis({ row }: { row: AnalyticsKpiRow }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {[
        { label: "Revenue",    value: fmtSek(row.revenue_sek) },
        { label: "Cost",       value: fmtSek(row.cost_sek) },
        { label: "Profit",     value: fmtSek(row.profit_sek), sub: `${pct(row.profit_sek, row.revenue_sek)} margin` },
        { label: "Units Sold", value: fmt(row.units_sold) },
        { label: "Orders",     value: fmt(row.order_count) },
      ].map(({ label, value, sub }) => (
        <div key={label} className="rounded-xl border border-border bg-card p-4 flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</span>
          <span className="text-2xl font-bold text-foreground">{value}</span>
          {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const SetBarLabel = (props: any) => {
  const { x, y, width, height, value } = props;
  if (!value || width < 28) return null;
  const maxChars = Math.max(4, Math.floor(width / 6.2));
  const text = value.length > maxChars ? value.slice(0, maxChars - 1) + "…" : value;
  return (
    <text x={(x as number) + 6} y={(y as number) + (height as number) / 2 + 4}
      fill="rgba(255,255,255,0.88)" fontSize={10} fontWeight={500}>
      {text}
    </text>
  );
};

const CARD = "rounded-xl border border-border bg-card";

export default function Analytics() {
  const [year, setYear]                           = useState<number | undefined>(undefined);
  const [granularity, setGranularity]             = useState<"month" | "year">("month");
  const [includeOtherGames, setIncludeOtherGames] = useState(false);

  const { data: years } = useQuery({ queryKey: ["analytics-years"], queryFn: fetchAnalyticsYears });

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["analytics-summary", year, includeOtherGames],
    queryFn:  () => fetchAnalyticsSummary(year, includeOtherGames),
    staleTime: 300000,
  });

  const { data: overTime, isLoading: timeLoading } = useQuery({
    queryKey: ["analytics-over-time", granularity, year, includeOtherGames],
    queryFn:  () => fetchAnalyticsOverTime(granularity, year, includeOtherGames),
    staleTime: 300000,
  });

  const { data: bySetCodeRaw, isLoading: setCodeLoading } = useQuery({
    queryKey: ["analytics-by-set-code", year],
    queryFn:  () => fetchAnalyticsBySetCode(year),
    staleTime: 300000,
  });

  const { data: byChannel, isLoading: channelLoading } = useQuery({
    queryKey: ["analytics-by-channel", year, includeOtherGames],
    queryFn:  () => fetchAnalyticsByChannel(year, includeOtherGames),
    staleTime: 300000,
  });

  // For all-time view, fetch predictions anchored to the last year in the data
  const lastDataYear = years?.[years.length - 1];
  const predYear = year ?? lastDataYear;

  const { data: predictions } = useQuery({
    queryKey: ["analytics-predictions", predYear, includeOtherGames],
    queryFn:  () => predYear ? fetchAnalyticsPredictions(predYear, includeOtherGames) : null,
    enabled:  !!predYear,
    staleTime: 300000,
  });

  // Filter out Others + bad prefixes (#, $, !, numbers, short)
  const bySetCode = bySetCodeRaw?.filter(r =>
    r.set_prefix !== "OTH" &&
    r.set_prefix.length >= 2 &&
    !/^\d+$/.test(r.set_prefix) &&
    !/^[#$!]/.test(r.set_prefix)
  );

  const totalChannelRevenue = byChannel?.reduce((s, c) => s + c.revenue_sek, 0) ?? 0;

  // Merge actual over-time data with predicted extension for the chart
  const chartData = useMemo(() => {
    if (!overTime) return [];

    const withNulls = (arr: typeof overTime) =>
      arr.map(d => ({ ...d, pred_revenue_sek: null as number | null, pred_profit_sek: null as number | null }));

    if (!predictions?.predictions?.length) return withNulls(overTime);

    // ── Yearly all-time: append a single predicted bar for next year ──────────
    if (granularity === "year" && year === undefined) {
      const actual = withNulls(overTime);
      // Bridge from last actual year so the dotted line starts there
      if (actual.length > 0) {
        const last = actual[actual.length - 1];
        last.pred_revenue_sek = last.revenue_sek ?? null;
        last.pred_profit_sek  = last.profit_sek  ?? null;
      }
      actual.push({
        period:           `${predictions.last_data_year + 1}-01-01`,
        revenue_sek:      null as any,
        profit_sek:       null as any,
        cost_sek:         null as any,
        units_sold:       null as any,
        order_count:      null as any,
        pred_revenue_sek: predictions.predicted_next_year_revenue,
        pred_profit_sek:  predictions.predicted_next_year_profit,
      });
      return actual;
    }

    // ── Monthly: only active in month granularity ─────────────────────────────
    if (granularity !== "month") return withNulls(overTime);

    // When a year is selected: only show partial_year predictions (remaining months of
    // that year). When all-time: show everything (partial_year + next_year).
    const filtered = year !== undefined
      ? predictions.predictions.filter(p => p.pred_type === "partial_year")
      : predictions.predictions;

    if (!filtered.length) return withNulls(overTime);

    // Trim actual data to only complete months so the chart doesn't show a
    // misleading dip from a mid-month pipeline cutoff.
    const cutoff = predictions.last_complete_year * 100 + predictions.last_complete_month;
    const trimmed = overTime.filter(d => {
      const [y, m] = d.period.split("-").map(Number);
      return y * 100 + m <= cutoff;
    });

    const actual = withNulls(trimmed);

    // Bridge: duplicate the last complete data point as the start of the
    // prediction line so the dotted line begins exactly where actuals end.
    if (actual.length > 0) {
      const last = actual[actual.length - 1];
      last.pred_revenue_sek = last.revenue_sek ?? null;
      last.pred_profit_sek  = last.profit_sek  ?? null;
    }

    const preds = filtered.map(d => ({
      period:           d.period,
      revenue_sek:      null as number | null,
      profit_sek:       null as number | null,
      units_sold:       null as number | null,
      pred_revenue_sek: d.pred_revenue_sek,
      pred_profit_sek:  d.pred_profit_sek,
    }));

    return [...actual, ...preds];
  }, [overTime, predictions, granularity, year]);

  const hasPredictions = !!(predictions?.predictions?.length) &&
    (granularity === "month" || (granularity === "year" && year === undefined));

  // Map prediction data to KPI boxes
  function predForYear(y: number | null): Partial<KpiBlockProps> {
    if (!predictions || y == null) return {};
    const yr = Math.round(y);
    if (yr === predictions.year) {
      // Current selected year — use predicted_year values
      return {
        predictedRevenue: predictions.predicted_year_revenue,
        predictedProfit:  predictions.predicted_year_profit,
      };
    }
    if (yr === predictions.year + 1) {
      // Next year
      return {
        predictedRevenue: predictions.predicted_next_year_revenue,
        predictedProfit:  predictions.predicted_next_year_profit,
        predictedUnits:   predictions.predicted_next_year_units,
      };
    }
    return {};
  }

  const formatPeriod = (p: string) => {
    if (!p) return "";
    return granularity === "year" ? p.slice(0, 4) : p.slice(0, 7);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <StoreHeader />
      <div className="container py-6 space-y-8">

        {/* ── Title + controls ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Singles Sales Analytics</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setIncludeOtherGames(!includeOtherGames)}
              className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                includeOtherGames
                  ? "bg-purple-600/20 border-purple-500/50 text-purple-300"
                  : "bg-card border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {includeOtherGames ? "● Other Games: On" : "○ Other Games"}
            </button>
            <select
              value={year ?? ""}
              onChange={(e) => setYear(e.target.value ? Number(e.target.value) : undefined)}
              className="text-sm bg-card border border-border rounded px-2 py-1.5 text-foreground"
            >
              <option value="">All time</option>
              {years?.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <div className="flex rounded border border-border overflow-hidden text-sm">
              {(["month", "year"] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setGranularity(g)}
                  className={`px-3 py-1.5 ${granularity === g ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
                >
                  {g === "month" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── KPI cards ── */}
        {summaryLoading ? (
          <div className="h-24 animate-pulse bg-card rounded-xl border border-border" />
        ) : summary?.mode === "all_time" ? (
          <AllTimeKpis row={summary.data[0]} />
        ) : summary?.mode === "year_comparison" && summary.data.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {summary.data.map((row, i) => (
              <KpiBlock
                key={row.year ?? i}
                row={row}
                isCenter={Math.round(row.year ?? 0) === summary.year}
                {...predForYear(row.year)}
              />
            ))}
          </div>
        ) : null}

        {/* ── Revenue & profit over time ── */}
        <div className={`${CARD} p-4`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">Revenue &amp; Profit over Time</h3>
            {hasPredictions && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <svg width="20" height="6">
                  <line x1="0" y1="3" x2="20" y2="3" stroke={COLOR_PRED_REV} strokeWidth="2" strokeDasharray="4 3" />
                </svg>
                Projected
              </div>
            )}
          </div>
          {timeLoading ? (
            <div className="h-56 animate-pulse bg-secondary/30 rounded" />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="hsl(215 70% 55%)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="hsl(215 70% 55%)" stopOpacity={0}    />
                  </linearGradient>
                  <linearGradient id="gradProfit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="hsl(145 60% 45%)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="hsl(145 60% 45%)" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 10, fill: "#64748b" }} />
                <Tooltip
                  formatter={(v: number, name: string) => {
                    const labels: Record<string, string> = {
                      revenue_sek:      "Revenue",
                      profit_sek:       "Profit",
                      pred_revenue_sek: "Revenue (projected)",
                      pred_profit_sek:  "Profit (projected)",
                    };
                    return [fmtSek(v), labels[name] ?? name];
                  }}
                  labelFormatter={formatPeriod}
                  contentStyle={TT_STYLE}
                  labelStyle={TT_LABEL}
                  itemStyle={TT_ITEM}
                  cursor={TT_CURSOR as any}
                />
                <Legend
                  formatter={(v) => ({
                    revenue_sek:      "Revenue",
                    profit_sek:       "Profit",
                    pred_revenue_sek: "Revenue (projected)",
                    pred_profit_sek:  "Profit (projected)",
                  }[v] ?? v)}
                  wrapperStyle={{ fontSize: 11 }}
                />
                {/* Actual lines */}
                <Area type="monotone" dataKey="revenue_sek" stroke="hsl(215 70% 60%)" fill="url(#gradRevenue)" strokeWidth={2} dot={false} connectNulls={false} />
                <Area type="monotone" dataKey="profit_sek"  stroke="hsl(145 60% 50%)" fill="url(#gradProfit)"  strokeWidth={2} dot={false} connectNulls={false} />
                {/* Predicted dotted lines */}
                {hasPredictions && (
                  <>
                    <Area type="monotone" dataKey="pred_revenue_sek" stroke={COLOR_PRED_REV} fill="none" strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} />
                    <Area type="monotone" dataKey="pred_profit_sek"  stroke={COLOR_PRED_PRF} fill="none" strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} />
                  </>
                )}
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── Set code + Channel ── */}
        <div className="grid md:grid-cols-2 gap-4">

          {/* Revenue by set code */}
          <div className={`${CARD} p-4`}>
            <h3 className="text-sm font-semibold mb-4">Revenue by Set (top 20)</h3>
            {setCodeLoading ? (
              <div className="h-72 animate-pulse bg-secondary/30 rounded" />
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(360, (bySetCode?.length ?? 20) * 22)}>
                <BarChart
                  data={bySetCode}
                  layout="vertical"
                  margin={{ top: 0, right: 44, left: 0, bottom: 0 }}
                  barCategoryGap="18%"
                >
                  <defs>
                    {SET_PALETTE.map((color, i) => (
                      <linearGradient key={i} id={`gradSet${i}`} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%"   stopColor={color} stopOpacity={0.65} />
                        <stop offset="100%" stopColor={color} stopOpacity={1}    />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                    tick={{ fontSize: 10, fill: "#64748b" }}
                    axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="display_name"
                    width={0}
                    tick={false}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<SetCodeTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
                  <Bar dataKey="revenue_sek" radius={[0, 4, 4, 0]} maxBarSize={16}>
                    <LabelList content={SetBarLabel} />
                    <LabelList
                      dataKey="revenue_sek"
                      position="right"
                      formatter={(v: number) => `${Math.round(v / 1000)}k`}
                      style={{ fill: "#64748b", fontSize: 9 }}
                    />
                    {bySetCode?.map((_, i) => (
                      <Cell key={i} fill={`url(#gradSet${i % SET_PALETTE.length})`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Channel split */}
          <div className={`${CARD} p-4`}>
            <h3 className="text-sm font-semibold mb-4">Channel Split</h3>
            {channelLoading ? (
              <div className="h-72 animate-pulse bg-secondary/30 rounded" />
            ) : byChannel && byChannel.length > 0 ? (
              <div className="flex flex-col gap-4">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <defs>
                      {CHANNEL_COLORS.map((color, i) => (
                        <radialGradient key={i} id={`gradPie${i}`} cx="50%" cy="50%" r="50%">
                          <stop offset="0%"   stopColor={color} stopOpacity={1}   />
                          <stop offset="100%" stopColor={color} stopOpacity={0.7} />
                        </radialGradient>
                      ))}
                    </defs>
                    <Pie
                      data={byChannel}
                      dataKey="revenue_sek"
                      nameKey="channel"
                      cx="50%" cy="50%"
                      innerRadius={60} outerRadius={90}
                      paddingAngle={4}
                    >
                      {byChannel.map((_, i) => (
                        <Cell key={i} fill={`url(#gradPie${i % CHANNEL_COLORS.length})`} stroke="rgba(0,0,0,0.2)" strokeWidth={1} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(v: number) => [fmtSek(v), "Revenue"]}
                      contentStyle={TT_STYLE}
                      labelStyle={TT_LABEL}
                      itemStyle={TT_ITEM}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-col gap-2 px-2">
                  {byChannel.map((c, i) => (
                    <div key={c.channel} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }} />
                        <span className="text-foreground font-medium">{c.channel}</span>
                        <span className="text-muted-foreground text-xs">{pct(c.revenue_sek, totalChannelRevenue)}</span>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        <span className="text-foreground font-medium">{fmtSek(c.revenue_sek)}</span>
                        <span className="ml-2">{fmt(c.units_sold)} units</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* ── Units sold over time ── */}
        <div className={`${CARD} p-4`}>
          <h3 className="text-sm font-semibold mb-4">
            Units Sold over Time
            {includeOtherGames && <span className="ml-2 text-xs text-muted-foreground font-normal">MTG + Other Games</span>}
          </h3>
          {timeLoading ? (
            <div className="h-40 animate-pulse bg-secondary/30 rounded" />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={overTime} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
                <defs>
                  <linearGradient id="gradMTG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={COLOR_MTG}   stopOpacity={1}    />
                    <stop offset="100%" stopColor={COLOR_MTG}   stopOpacity={0.55} />
                  </linearGradient>
                  <linearGradient id="gradOther" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={COLOR_OTHER} stopOpacity={1}    />
                    <stop offset="100%" stopColor={COLOR_OTHER} stopOpacity={0.55} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => fmt(v)} tick={{ fontSize: 10, fill: "#64748b" }} />
                <Tooltip
                  formatter={(v: number, name: string) => [
                    fmt(v),
                    name === "mtg_units" ? "MTG" : name === "other_units" ? "Other Games" : "Units",
                  ]}
                  labelFormatter={formatPeriod}
                  contentStyle={TT_STYLE}
                  labelStyle={TT_LABEL}
                  itemStyle={TT_ITEM}
                  cursor={TT_CURSOR as any}
                />
                {includeOtherGames ? (
                  <>
                    <Legend formatter={(v) => v === "mtg_units" ? "MTG" : "Other Games"} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="mtg_units"   stackId="a" fill="url(#gradMTG)"   radius={[0, 0, 0, 0]} />
                    <Bar dataKey="other_units" stackId="a" fill="url(#gradOther)" radius={[3, 3, 0, 0]} />
                  </>
                ) : (
                  <Bar dataKey="units_sold" fill="url(#gradMTG)" radius={[3, 3, 0, 0]} />
                )}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

      </div>
    </div>
  );
}
