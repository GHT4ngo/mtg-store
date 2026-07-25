import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

interface Release {
  version: string;
  date: string;
  tag: "current" | "previous";
  changes: { category: string; items: string[] }[];
}

const CHANGELOG: Release[] = [
  {
    version: "Alpha 1.2",
    date: "April 2026",
    tag: "current",
    changes: [
      {
        category: "Analytics",
        items: [
          "Sales Analytics page — revenue, profit, units sold charts from 10 years of order history",
          "KPI comparison boxes: year-1 / selected year / year+1 with margin and projected full-year",
          "Revenue & Profit chart: red dotted projection line extends from last data point to end of year",
          "Prediction for rest of current year + full next year using linear trend extrapolation (3-year basis)",
          "All-time view: dotted line extends from last data point through end of current year + next year",
          "Predictions anchored to last complete month — partial months excluded to avoid chart dips",
          "Revenue by Set (top 20): set names overlaid inside bars with revenue value after bar, Scryfall set symbol on hover",
          "Other Games toggle: includes non-MTG card singles in all KPIs, charts and predictions",
          "In-store vs shipped channel split with donut chart",
          "Year filter and monthly/yearly granularity toggle on all charts",
          "MTG bulk products ('MTG:' prefix) now included in sales data",
        ],
      },
      {
        category: "Search & Filters",
        items: [
          "Price filter (min/max SEK) now applied in SQL — pagination and totals were previously broken for price searches",
          "AI agent search correctly returns cards over a price threshold",
        ],
      },
      {
        category: "Pipeline",
        items: [
          "Order ingestion: 271k+ sales rows (MTG singles + MTG bulk + other card game singles) synced from MySQL",
          "New bronze → silver → gold dbt pipeline for sales data",
          "gold_sales_daily pre-aggregated table (date × set group × channel × game) for fast API queries",
          "dim_date spine table (2015–2030) added to silver layer",
        ],
      },
    ],
  },
  {
    version: "Alpha 1.1",
    date: "April 2026",
    tag: "previous",
    changes: [
      {
        category: "New Features",
        items: [
          "Decklist checker — paste or upload any MTGGoldfish/Arena decklist",
          "Multi-variant selection in decklist: split a 4-of across different printings",
          "Auto-selects cheapest available version per card",
          "Add entire decklist to cart in one click",
          "EUR price input for manual price overrides and no-price cards",
          "Prerelease Foil, Etched Foil, Silver Foil labels on card variants",
          "The List badge on cards from The List",
          "Space background on desktop",
          "Icons in navigation bar, mobile-responsive nav",
        ],
      },
      {
        category: "Fixes",
        items: [
          "Condition discount badges now show correctly (was showing phantom -10% on NM cards)",
          "Prices display as whole numbers with no decimals",
          "Foil cards no longer appear in the no-price admin list",
          "Token cards filtered from no-price list",
          "Judge promos (J21/J22/J23/J24) now correctly routed to their Scryfall sets",
          "Judge reward cards correctly detected as foil-only",
          "Split cards and double-faced cards resolve correctly in decklist search",
          "Duplicate card entries in gold layer resolved",
          "GP promo cards now fall back to Scryfall USD price when Cardmarket shows 0",
        ],
      },
    ],
  },
  {
    version: "Alpha 1.0",
    date: "2026",
    tag: "previous",
    changes: [
      {
        category: "Core Platform",
        items: [
          "Card browse with search, filters (color, type, rarity, CMC, price, foil, language)",
          "AI-powered natural language search (Claude Haiku)",
          "Automated pricing pipeline: Scryfall + Cardmarket → PostgreSQL via dbt",
          "EUR→SEK conversion via Riksbank live exchange rates",
          "Real-time stock delta layer (no full rebuild needed between imports)",
        ],
      },
      {
        category: "Staff Tools",
        items: [
          "Manabox CSV bulk import with preview and verification",
          "Trade-in workflow: preview → submit → import to stock",
          "Admin panel: price overrides, no-price dashboard, match quality report",
          "Condition-adjusted sell prices with discount badges",
          "Multi-location stock support (A/B/C warehouses)",
        ],
      },
    ],
  },
];

function ReleaseBlock({ release }: { release: Release }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-base font-bold text-foreground">{release.version}</span>
        {release.tag === "current" && (
          <Badge className="text-[10px] bg-primary/20 text-primary border-primary/30">current</Badge>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{release.date}</span>
      </div>
      {release.changes.map((section) => (
        <div key={section.category}>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground/60 mb-1.5">{section.category}</div>
          <ul className="space-y-1">
            {section.items.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <span className="text-primary mt-0.5 shrink-0">·</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono tracking-wide">Changelog</DialogTitle>
        </DialogHeader>
        <div className="space-y-8 pt-2">
          {CHANGELOG.map((release, i) => (
            <div key={release.version}>
              <ReleaseBlock release={release} />
              {i < CHANGELOG.length - 1 && <div className="border-t border-border mt-6" />}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
