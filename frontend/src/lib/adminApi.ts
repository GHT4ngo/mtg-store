const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const headers = { "ngrok-skip-browser-warning": "true" };

export interface MatchStats {
  total_mysql: number;
  matched: number;
  unmatched: number;
  match_pct: number;
}

export interface UnmatchedRow {
  reference: string;
  name: string;
  stock_a: number;
  condition: string | null;
  corrected_set_code: string | null;
  corrected_collector_number: string | null;
}

export interface NoPriceCard {
  reference: string;
  name: string;
  set_code: string;
  set_name?: string;
  collector_number: string;
  is_foil: boolean;
  condition: string | null;
  stock_a: number;
  price_trend_eur?: number | null;
  sell_price_sek?: number | null;
}

export interface CardLookupResult {
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  image_url_small: string;
  sell_price_sek: number | null;
  sell_price_foil_sek: number | null;
}

export interface PriceOverride {
  set_code: string;
  collector_number: string;
  is_foil: boolean;
  price_sek: number;
  name?: string | null;
  set_name?: string | null;
  image_url_small?: string | null;
  created_at?: string;
  updated_at?: string;
}

export async function fetchMatchStats(): Promise<MatchStats> {
  const res = await fetch(`${BASE_URL}/admin/match-stats`, { headers });
  if (!res.ok) throw new Error("Failed to fetch match stats");
  return res.json();
}

export async function fetchUnmatched(): Promise<UnmatchedRow[]> {
  const res = await fetch(`${BASE_URL}/admin/unmatched`, { headers });
  if (!res.ok) throw new Error("Failed to fetch unmatched cards");
  return res.json();
}

export async function saveCorrection(reference: string, set_code: string, collector_number: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin/corrections`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ reference, set_code, collector_number }),
  });
  if (!res.ok) throw new Error("Failed to save correction");
}

export async function deleteCorrection(reference: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin/corrections/${encodeURIComponent(reference)}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error("Failed to delete correction");
}

export async function fetchNoPriceCards(): Promise<NoPriceCard[]> {
  const res = await fetch(`${BASE_URL}/admin/no-price`, { headers });
  if (!res.ok) throw new Error("Failed to fetch no-price cards");
  return res.json();
}

export async function savePriceOverride(data: {
  set_code: string;
  collector_number: string;
  is_foil: boolean;
  price_sek?: number;
  price_eur?: number;
  percent_increase?: number;
}): Promise<any> {
  const res = await fetch(`${BASE_URL}/admin/price-overrides`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to save price override");
  return res.json();
}

export async function fetchCardLookup(set_code: string, collector_number: string): Promise<CardLookupResult> {
  const res = await fetch(`${BASE_URL}/admin/card-lookup?set_code=${encodeURIComponent(set_code)}&collector_number=${encodeURIComponent(collector_number)}`, { headers });
  if (!res.ok) throw new Error("Card not found");
  return res.json();
}

export async function fetchPriceOverrides(): Promise<PriceOverride[]> {
  const res = await fetch(`${BASE_URL}/admin/price-overrides`, { headers });
  if (!res.ok) throw new Error("Failed to fetch price overrides");
  return res.json();
}

export async function deletePriceOverride(set_code: string, collector_number: string, is_foil: boolean): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin/price-overrides/${encodeURIComponent(set_code)}/${encodeURIComponent(collector_number)}?is_foil=${is_foil}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error("Failed to delete price override");
}
