const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const headers = { "ngrok-skip-browser-warning": "true" };

export interface PricingRule {
  id: number;
  category: string;
  rule_key: string;
  label: string;
  value: number;
  suffix: string | null;
  is_active: boolean;
  changed_at: string | null;
  changed_by: string | null;
}

export interface PricingRulesResponse {
  buy_valuation: PricingRule[];
  buy_multiplier: PricingRule[];
  sell_condition: PricingRule[];
  sell_minimum?: PricingRule[];
}

export interface AuditEntry {
  id: number;
  changed_at: string;
  changed_by: string;
  section: string;
  rule_label: string;
  new_value: string;
}

export async function fetchPricingAudit(): Promise<AuditEntry[]> {
  const res = await fetch(`${BASE_URL}/pricing/audit`, { headers });
  if (!res.ok) throw new Error("Failed to fetch pricing audit");
  return res.json();
}

export interface PricingRange {
  id: number;
  range_min: number;
  range_max: number | null;
  magic_number: number;
  fixed_sek: number | null;
  label: string;
  is_active: boolean;
  changed_at: string | null;
  changed_by: string | null;
  display_lower_sek: number | null;
  display_upper_sek: number | null;
}

export async function fetchPricingRules(): Promise<PricingRulesResponse> {
  const res = await fetch(`${BASE_URL}/pricing/rules`, { headers });
  if (!res.ok) throw new Error("Failed to fetch pricing rules");
  return res.json();
}

export async function fetchPricingRanges(): Promise<PricingRange[]> {
  const res = await fetch(`${BASE_URL}/pricing/ranges`, { headers });
  if (!res.ok) throw new Error("Failed to fetch pricing ranges");
  return res.json();
}

export async function updatePricingRule(
  id: number,
  data: { value?: number; is_active?: boolean; changed_by: string }
): Promise<PricingRule> {
  const res = await fetch(`${BASE_URL}/pricing/rules/${id}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update pricing rule");
  return res.json();
}

export async function updatePricingRange(
  id: number,
  data: { magic_number?: number; fixed_sek?: number | null; is_active?: boolean; changed_by: string }
): Promise<PricingRange> {
  const res = await fetch(`${BASE_URL}/pricing/ranges/${id}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update pricing range");
  return res.json();
}

export function getEditorName(): string | null {
  return localStorage.getItem("pricing_editor_name");
}

export function setEditorName(name: string) {
  localStorage.setItem("pricing_editor_name", name);
}

export async function resetPricingDefaults(changed_by: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/pricing/reset`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ changed_by }),
  });
  if (!res.ok) throw new Error("Failed to reset pricing to defaults");
}
