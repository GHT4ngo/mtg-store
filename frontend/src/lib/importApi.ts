const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const headers = { "ngrok-skip-browser-warning": "true" };

export interface ImportRow {
  name: string;
  set_code: string;
  collector_number: string;
  foil: "foil" | "normal";
  condition: string;
  alphaspel_condition?: string;
  quantity: number;
  current_stock: number | null;
  current_stock_a: number | null;
  current_stock_b: number | null;
  current_stock_c: number | null;
  new_stock: number | null;
  new_stock_value: number | null;
  delta: number;
  match_status: "matched" | "condition_mismatch" | "not_in_alphaspel" | "zero_stock";
  match_tier?: string;
  reference?: string;
  apply_action?: "updated" | "inserted" | null;
  apply_error?: string | null;
  sell_price_sek?: number | null;
  image_url_small?: string | null;
}

export interface ImportUploadResponse {
  import_id: number;
  filename: string;
  uploaded_at: string;
  status: string;
  row_count: number;
  matched_count: number;
  changed_count: number;
  rows: ImportRow[];
}

export interface ImportConfirmResponse {
  status: string;
  updated_count: number;
  errors: string[];
}

export interface ImportHistoryEntry {
  import_id: number;
  filename: string;
  uploaded_at: string;
  row_count: number;
  matched_count: number;
  status: string;
  verify_ok?: number;
  verify_fail?: number;
  verified_at?: string | null;
}

export interface VerifyRow {
  name: string;
  set_code: string;
  collector_number: string;
  foil: "foil" | "normal";
  expected_stock: number;
  actual_stock: number;
  verified: boolean;
  updated_at?: string;
  reference?: string;
  actual_ref?: string;
  condition?: string;
  actual_cond?: string | null;
  issue?: string;
}

export interface ImportVerifyResponse {
  status: string;
  verified_count: number;
  failed_count: number;
  applied_count?: number;
  rows: VerifyRow[];
}

function normalizeVerifyResponse(data: any): ImportVerifyResponse {
  const rows: VerifyRow[] = (data.rows ?? data.results ?? []).map((r: any) => ({
    name: r.name ?? "",
    set_code: r.set_code ?? "",
    collector_number: r.collector_number ?? "",
    foil: r.foil ?? "normal",
    expected_stock: r.expected_stock ?? r.expected ?? 0,
    actual_stock: r.actual_stock ?? r.actual ?? 0,
    verified: r.verified ?? r.ok ?? false,
    updated_at: r.updated_at,
    reference: r.reference,
    actual_ref: r.actual_ref,
    condition: r.condition,
    actual_cond: r.actual_cond,
    issue: r.issue,
  }));

  return {
    status: data.status ?? "ok",
    verified_count: data.verified_count ?? data.verified ?? rows.filter(r => r.verified).length,
    failed_count: data.failed_count ?? data.failed ?? rows.filter(r => !r.verified).length,
    applied_count: data.applied_count,
    rows,
  };
}

export class DuplicateImportError extends Error {
  import_id: number;
  status: string;
  constructor(importId: number, status: string) {
    super("Duplicate import");
    this.import_id = importId;
    this.status = status;
  }
}

export async function uploadImportFile(file: File, force = false): Promise<ImportUploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const url = `${BASE_URL}/import/upload${force ? "?force=true" : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const detail: string = body.detail ?? "";
    const idMatch = detail.match(/import #(\d+)/);
    const statusMatch = detail.match(/status:\s*(\w+)/);
    throw new DuplicateImportError(
      idMatch ? parseInt(idMatch[1], 10) : (body.import_id ?? 0),
      statusMatch ? statusMatch[1] : "unknown",
    );
  }
  if (!res.ok) throw new Error("Upload failed");
  return res.json();
}

export async function confirmImport(importId: number): Promise<ImportConfirmResponse> {
  const res = await fetch(`${BASE_URL}/import/${importId}/confirm`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error("Confirm failed");
  return res.json();
}

export interface ImportStatusResponse {
  import_id: number;
  status: "confirming" | "confirmed" | "pending" | "cancelled" | "failed";
  row_count: number;
  applied_count: number;
  confirmed_at: string | null;
}

export async function confirmImportAsync(importId: number): Promise<{ status: string; row_count: number }> {
  const res = await fetch(`${BASE_URL}/import/${importId}/confirm-async`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error("Async confirm failed");
  return res.json();
}

export async function fetchImportStatus(importId: number): Promise<ImportStatusResponse> {
  const res = await fetch(`${BASE_URL}/import/${importId}/status`, { headers });
  if (!res.ok) throw new Error("Failed to fetch import status");
  return res.json();
}

export async function fetchImportHistory(): Promise<ImportHistoryEntry[]> {
  const res = await fetch(`${BASE_URL}/import/history`, { headers });
  if (!res.ok) throw new Error("Failed to fetch history");
  return res.json();
}

export async function fetchImportPreview(importId: number): Promise<ImportUploadResponse> {
  const res = await fetch(`${BASE_URL}/import/${importId}/preview`, { headers });
  if (!res.ok) throw new Error("Failed to fetch preview");
  return res.json();
}

export async function verifyImport(importId: number): Promise<ImportVerifyResponse> {
  const res = await fetch(`${BASE_URL}/import/${importId}/verify`, { headers });
  if (!res.ok) throw new Error("Failed to verify import");
  const data = await res.json();
  return normalizeVerifyResponse(data);
}

export interface ImportRevokeResponse {
  import_id: number;
  status: string;
  reverted: number;
  errors: string[];
}

export async function revokeImport(importId: number): Promise<ImportRevokeResponse> {
  const res = await fetch(`${BASE_URL}/import/${importId}/revoke`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error("Revoke failed");
  return res.json();
}

// Bulk set import types & API

export interface BulkSetCard {
  scryfall_id: string;
  reference: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  current_stock: number;
  total_stock_all: number;
  sell_price_sek: number | null;
  sell_price_foil_sek: number | null;
  image_url_small?: string | null;
  sold_last_year?: number;
  sold_total?: number;
  sold_last_year_all?: number;
  sold_total_all?: number;
  in_mysql?: boolean;
}

export interface BulkConfirmRow {
  scryfall_id: string;
  reference: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  condition: string;
  foil: boolean;
  quantity: number;
  current_stock: number;
}

export interface BulkConfirmResponse {
  import_id: number;
  status: string;
  updated_count: number;
  errors: string[];
}

export async function fetchBulkSetCards(setCode: string): Promise<BulkSetCard[]> {
  const res = await fetch(`${BASE_URL}/bulk/sets/${setCode}/cards`, { headers });
  if (!res.ok) throw new Error("Failed to fetch set cards");
  const data = await res.json();
  console.log("Bulk set API response:", data);
  return data.cards ?? data;
}

export async function confirmBulkImport(setCode: string, rows: BulkConfirmRow[]): Promise<BulkConfirmResponse> {
  const res = await fetch(`${BASE_URL}/bulk/confirm`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ set_code: setCode, rows }),
  });
  if (!res.ok) throw new Error("Bulk confirm failed");
  return res.json();
}
