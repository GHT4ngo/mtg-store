/** LGS condition codes → human-readable labels */
export const CONDITION_OPTIONS = [
  { value: "NM", label: "Near Mint" },
  { value: "VF", label: "Excellent" },
  { value: "FN", label: "Good" },
  { value: "GD", label: "Played" },
  { value: "FR", label: "Heavily Played" },
  { value: "PR", label: "Poor / Damaged" },
] as const;

const LABEL_MAP: Record<string, string> = Object.fromEntries(
  CONDITION_OPTIONS.map((o) => [o.value, o.label])
);

/** Map a condition code to its display label. Falls back to the code itself. */
export function conditionLabel(code: string | null | undefined): string {
  return LABEL_MAP[code ?? ""] ?? code ?? "NM";
}

/** Sort order for condition codes (best → worst) */
export const CONDITION_SORT: Record<string, number> = {
  MT: 0, NM: 1, VF: 2, FN: 3, GD: 4, FR: 5, PR: 6,
};

export function getConditionSort(c: string | null): number {
  return CONDITION_SORT[c ?? ""] ?? 99;
}
