const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const headers = { "ngrok-skip-browser-warning": "true" };

export interface TradeInRow {
  id?: number;
  row_id?: number;
  scryfall_id: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  foil: string;
  condition: string;
  language: string;
  quantity: number;
  price_trend_eur: number | null;
  tradein_final_sek: number;
  tradein_total_sek?: number;
  multiplier_notes: string;
  image_url_small?: string | null;
  missing_price?: boolean;
  over_threshold?: boolean;
}

export interface UpdateRowResponse {
  tradein_final_sek: number;
  tradein_total_sek: number;
  tradein_base_sek: number;
  price_trend_eur: number | null;
  sell_price_sek: number;
  multiplier_notes: string;
  missing_price: boolean;
  over_threshold: boolean;
  session_total_sek: number;
}

export async function updateTradeInRow(
  token: string,
  rowId: number,
  body: Record<string, unknown>
): Promise<UpdateRowResponse> {
  const res = await fetch(`${BASE_URL}/tradein/${token}/rows/${rowId}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error("Failed to update row");
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

export interface TradeInPreviewResponse {
  rows: TradeInRow[];
  total_cards: number;
  unique_cards: number;
  trade_cards_sek: number;
  trade_products_sek: number;
  trade_cash_sek: number;
  missing_price: { name: string; set_code: string }[];
}

export interface TradeInSubmitResponse {
  token: string;
  email: string;
  trade_type: string;
  total_value_sek: number;
  row_count: number;
}

export interface TradeInSession {
  token: string;
  email: string;
  trade_type: string;
  total_value_sek: number;
  created_at: string;
  status: string;
  rows: TradeInRow[];
}

export async function uploadTradeInPreview(file: File): Promise<TradeInPreviewResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${BASE_URL}/tradein/preview`, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!res.ok) throw new Error("Trade-in preview failed");
  return res.json();
}

export async function recalcTradeInPreview(rows: TradeInRow[]): Promise<TradeInPreviewResponse> {
  const res = await fetch(`${BASE_URL}/tradein/preview`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) throw new Error("Trade-in recalculation failed");
  return res.json();
}

export async function submitTradeIn(
  email: string,
  tradeType: string,
  rows: TradeInRow[]
): Promise<TradeInSubmitResponse> {
  const res = await fetch(`${BASE_URL}/tradein/submit`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ email, trade_type: tradeType, rows }),
  });
  if (!res.ok) throw new Error("Trade-in submission failed");
  return res.json();
}

export async function lookupTradeIn(token: string): Promise<TradeInSession> {
  const res = await fetch(`${BASE_URL}/tradein/${token}`, { headers });
  if (!res.ok) throw new Error("Trade-in not found");
  return res.json();
}

export interface CardSetOption {
  set_code: string;
  set_name: string;
  released_at: string;
}

export interface CardPrintingOption {
  scryfall_id: string;
  collector_number: string;
  foil: boolean;
  nonfoil: boolean;
  image_url_small?: string | null;
}

export async function fetchCardOptions(
  name: string,
  setCode?: string
): Promise<CardSetOption[] | CardPrintingOption[]> {
  const params = new URLSearchParams({ name });
  if (setCode) params.set("set_code", setCode);
  const res = await fetch(`${BASE_URL}/tradein/card-options?${params}`, { headers });
  if (!res.ok) throw new Error("Failed to fetch card options");
  return res.json();
}

export interface ImportToStockResponse {
  import_id: number;
  token: string;
  row_count: number;
  status: string;
  message: string;
}

export async function importTradeInToStock(token: string): Promise<ImportToStockResponse> {
  const res = await fetch(`${BASE_URL}/tradein/${token}/import-to-stock`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error("Import to stock failed");
  return res.json();
}
