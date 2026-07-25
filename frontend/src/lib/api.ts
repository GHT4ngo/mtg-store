const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const headers = { "ngrok-skip-browser-warning": "true" };

export interface Card {
  scryfall_id: string;
  name: string;
  set_name: string;
  set_code: string;
  collector_number: string;
  rarity: string;
  type_line: string;
  mana_cost: string;
  cmc: number;
  colors: string[];
  color_identity: string[];
  artist: string;
  image_url_normal: string;
  image_url_small: string;
  image_url_back: string | null;
  in_stock: boolean;
  total_stock: number;
  stock_a: number;
  stock_b: number;
  stock_c: number;
  is_foil: boolean;
  price_avg_sek: number | null;
  price_trend_sek: number | null;
  price_avg_foil_sek: number | null;
  price_trend_foil_sek: number | null;
  price_date: string | null;
  sell_price_sek: number | null;
  sell_price_foil_sek: number | null;
  condition: string | null;
  condition_discount: number | null;
  data_quality: string | null;
  match_type: string | null;
  language: string | null;
  special_print: string | null;
  special_foil_type: string | null;
  is_signed: boolean;
}

export interface CardListResponse {
  cards: Card[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  pages?: number;
}

export interface SetInfo {
  set_code: string;
  set_name: string;
  set_group: string;
}

export interface StoreStats {
  total_cards: number;
  cards_in_stock: number;
  total_units: number;
  total_sets: number;
}

export interface CardGroup {
  name: string;
  type_line: string;
  image_url_small: string;
  printings: Card[];
  totalStock: number;
  priceRange: { min: number | null; max: number | null };
  hasFoil: boolean;
  foilPriceRange: { min: number | null; max: number | null };
  versionCount: number;
}

export interface AISearchResponse {
  filters: Record<string, string | boolean | number>;
  chips: { label: string; param: string; value: string | boolean | number }[];
}

export async function aiSearch(query: string): Promise<AISearchResponse> {
  const res = await fetch(`${BASE_URL}/agent/search`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error("AI search failed");
  return res.json();
}

export async function fetchCards(params: Record<string, any>): Promise<CardListResponse> {
  const searchParams = new URLSearchParams();
  const stringKeys = ["name", "set_code", "rarity", "color", "type_line", "oracle_text"];
  const numericKeys = ["min_cmc", "max_cmc", "min_price", "max_price"];
  const boolKeys = ["in_stock", "foil"];

  for (const k of stringKeys) {
    if (params[k]) searchParams.set(k, params[k]);
  }
  for (const k of numericKeys) {
    if (params[k] !== undefined && params[k] !== "") searchParams.set(k, String(params[k]));
  }
  for (const k of boolKeys) {
    if (params[k] === true) searchParams.set(k, "true");
  }
  searchParams.set("page", String(params.page || 1));
  searchParams.set("page_size", String(params.page_size || 100));

  const res = await fetch(`${BASE_URL}/cards?${searchParams}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch cards");
  const data = await res.json();

  return { ...data, cards: data.cards ?? [], total_pages: data.pages ?? data.total_pages ?? 1 };
}

export async function fetchCard(scryfallId: string): Promise<Card> {
  const res = await fetch(`${BASE_URL}/cards/${scryfallId}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch card");
  return res.json();
}

export async function fetchSets(): Promise<SetInfo[]> {
  const res = await fetch(`${BASE_URL}/sets`, { headers });
  if (!res.ok) throw new Error("Failed to fetch sets");
  return res.json();
}

export async function fetchStats(): Promise<StoreStats> {
  const res = await fetch(`${BASE_URL}/stats`, { headers });
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

/** Get the sell price for a card based on foil status. Returns null if null or 0. */
export function getSellPrice(card: Card): number | null {
  const price = card.is_foil ? card.sell_price_foil_sek : card.sell_price_sek;
  return (price && price > 0) ? price : null;
}

/** Get display price: sell_price_sek already includes condition discount from the API.
 *  Only apply the language multiplier here, then round to nearest 5. */
export function getDiscountedPrice(card: Card): number | null {
  const base = getSellPrice(card);
  if (base === null) return null;
  const languageMultiplier = (card.language && card.language !== "English") ? 0.90 : 1.0;
  return Math.round(base * languageMultiplier / 5) * 5;
}

/** Check if a card is non-English */
export function isNonEnglish(card: Card): boolean {
  return !!card.language && card.language !== "English";
}

/** Get the back face URL for double-faced cards */
export function getBackFaceUrl(card: Card): string | null {
  return card.image_url_back ?? null;
}

export function groupCardsByName(cards: Card[]): CardGroup[] {
  const map = new Map<string, Card[]>();
  for (const card of cards) {
    const existing = map.get(card.name) || [];
    existing.push(card);
    map.set(card.name, existing);
  }

  const groups: CardGroup[] = [];
  for (const [name, printings] of map) {
    printings.sort((a, b) => {
      if (a.in_stock !== b.in_stock) return a.in_stock ? -1 : 1;
      return b.set_name.localeCompare(a.set_name);
    });

    const totalStock = printings.reduce((sum, c) => sum + c.total_stock, 0);
    const hasFoil = printings.some((c) => c.is_foil);

    // Price ranges using sell prices only
    const nonFoilPrices = printings
      .filter((c) => !c.is_foil)
      .map((c) => c.sell_price_sek)
      .filter((p): p is number => p !== null && p > 0);
    const foilPrices = printings
      .filter((c) => c.is_foil)
      .map((c) => c.sell_price_foil_sek)
      .filter((p): p is number => p !== null && p > 0);

    const priceRange = {
      min: nonFoilPrices.length ? Math.min(...nonFoilPrices) : null,
      max: nonFoilPrices.length ? Math.max(...nonFoilPrices) : null,
    };
    const foilPriceRange = {
      min: foilPrices.length ? Math.min(...foilPrices) : null,
      max: foilPrices.length ? Math.max(...foilPrices) : null,
    };

    const uniqueSets = new Set(printings.map((c) => `${c.set_code}-${c.collector_number}-${c.is_foil}-${c.condition}`));

    groups.push({
      name,
      type_line: printings[0].type_line,
      image_url_small: printings.find((c) => c.in_stock)?.image_url_small || printings[0].image_url_small,
      printings,
      totalStock,
      priceRange,
      hasFoil,
      foilPriceRange,
      versionCount: uniqueSets.size,
    });
  }

  groups.sort((a, b) => {
    if ((a.totalStock > 0) !== (b.totalStock > 0)) return a.totalStock > 0 ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return groups;
}

export function formatPrice(price: number | null): string {
  if (price === null || price === undefined || price === 0) return "–";
  return `${Math.round(price)} kr`;
}

// ─── Decklist Checker ──────────────────────────────────────────────────────

export interface DecklistSummary {
  total_cards: number;
  filled_cards: number;
  missing_cards: number;
  cheapest_sek: number;
  unique_names: number;
  names_found: number;
  names_missing: number;
}

export interface DecklistCardResult {
  requested_name: string;
  requested_qty: number;
  total_available: number;
  can_fill: boolean;
  cheapest_price: number | null;
  cheapest_total: number | null;
  variants: Card[];
}

export interface DecklistResponse {
  deck_name: string;
  main: DecklistCardResult[];
  sideboard: DecklistCardResult[];
  summary_main: DecklistSummary;
  summary_side: DecklistSummary;
}

export async function searchDecklist(text: string, deckName?: string): Promise<DecklistResponse> {
  const res = await fetch(`${BASE_URL}/decklist/search`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ text, deck_name: deckName ?? "" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail ?? "Decklist search failed");
  }
  return res.json();
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface AnalyticsKpiRow {
  year: number | null;
  units_sold: number;
  order_count: number;
  revenue_sek: number;
  cost_sek: number;
  profit_sek: number;
  is_partial?: boolean;
  projected_revenue_sek?: number;
  projected_profit_sek?: number;
  projected_units_sold?: number;
}

export interface AnalyticsSummaryResponse {
  mode: "all_time" | "year_comparison";
  year?: number;
  data: AnalyticsKpiRow[];
}

export interface AnalyticsTimeSeries {
  period: string;
  revenue_sek: number;
  cost_sek: number;
  profit_sek: number;
  // MTG-only mode
  units_sold?: number;
  order_count?: number;
  // Game-split mode
  mtg_units?: number;
  other_units?: number;
}

export interface AnalyticsSetCode {
  display_name: string;
  set_prefix: string;
  units_sold: number;
  revenue_sek: number;
  cost_sek: number;
  profit_sek: number;
}

export interface AnalyticsChannel {
  channel: string;
  units_sold: number;
  revenue_sek: number;
  cost_sek: number;
  profit_sek: number;
}

export async function fetchAnalyticsSummary(year?: number, includeOtherGames = false): Promise<AnalyticsSummaryResponse> {
  const params = new URLSearchParams();
  if (year) params.set("year", String(year));
  if (includeOtherGames) params.set("include_other_games", "true");
  const qs = params.toString();
  const res = await fetch(`${BASE_URL}/analytics/summary${qs ? `?${qs}` : ""}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch analytics summary");
  return res.json();
}

export async function fetchAnalyticsOverTime(
  granularity: "day" | "week" | "month" | "year" = "month",
  year?: number,
  includeOtherGames = false,
): Promise<AnalyticsTimeSeries[]> {
  const params = new URLSearchParams({ granularity });
  if (year) params.set("year", String(year));
  if (includeOtherGames) params.set("include_other_games", "true");
  const res = await fetch(`${BASE_URL}/analytics/over-time?${params}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch analytics over time");
  return res.json();
}

export async function fetchAnalyticsBySetCode(year?: number): Promise<AnalyticsSetCode[]> {
  const params = year ? `?year=${year}` : "";
  const res = await fetch(`${BASE_URL}/analytics/by-set-code${params}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch analytics by set code");
  return res.json();
}

export async function fetchAnalyticsByChannel(
  year?: number,
  includeOtherGames = false,
): Promise<AnalyticsChannel[]> {
  const params = new URLSearchParams();
  if (year) params.set("year", String(year));
  if (includeOtherGames) params.set("include_other_games", "true");
  const res = await fetch(`${BASE_URL}/analytics/by-channel?${params}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch analytics by channel");
  return res.json();
}

export async function fetchAnalyticsYears(): Promise<number[]> {
  const res = await fetch(`${BASE_URL}/analytics/years`, { headers });
  if (!res.ok) throw new Error("Failed to fetch analytics years");
  return res.json();
}

export interface AnalyticsPredictionPoint {
  period: string;
  pred_revenue_sek: number;
  pred_profit_sek: number;
  pred_units: number;
  pred_type: "partial_year" | "next_year";
}

export interface AnalyticsPredictions {
  year: number;
  last_data_year: number;
  last_data_month: number;
  last_complete_year: number;
  last_complete_month: number;
  predictions: AnalyticsPredictionPoint[];
  predicted_year_revenue: number;
  predicted_year_profit: number;
  predicted_next_year_revenue: number;
  predicted_next_year_profit: number;
  predicted_next_year_units: number;
}

export async function fetchAnalyticsPredictions(year: number, includeOtherGames = false): Promise<AnalyticsPredictions> {
  const params = new URLSearchParams({ year: String(year) });
  if (includeOtherGames) params.set("include_other_games", "true");
  const res = await fetch(`${BASE_URL}/analytics/predictions?${params}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch analytics predictions");
  return res.json();
}
