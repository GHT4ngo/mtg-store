import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Info, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import StoreHeader from "@/components/StoreHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import {
  fetchPricingRules,
  fetchPricingRanges,
  fetchPricingAudit,
  updatePricingRule,
  updatePricingRange,
  resetPricingDefaults,
  getEditorName,
  setEditorName,
  type PricingRule,
  type PricingRange,
  type PricingRulesResponse,
  type AuditEntry,
} from "@/lib/pricingApi";

const EUR_SEK_RATE = 11.5;

function roundTo5(n: number): number {
  return Math.round(n / 5) * 5;
}

/* ─── Editor name with 2-char validation ─── */
function promptEditorName(): string | null {
  let name = getEditorName();
  if (name && name.length >= 2) return name;
  while (true) {
    name = window.prompt("Enter your name (min 2 characters, for change tracking):");
    if (name === null) return null; // cancelled
    if (name.trim().length >= 2) {
      setEditorName(name.trim());
      return name.trim();
    }
    window.alert("Please enter at least 2 characters.");
  }
}

function useDebouncedSave<T>(
  saveFn: (id: number, data: T) => Promise<any>,
  delay = 500
) {
  const timers = useRef<Map<number, NodeJS.Timeout>>(new Map());
  const [saved, setSaved] = useState<Set<number>>(new Set());

  const trigger = useCallback(
    (id: number, data: T) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(async () => {
          try {
            await saveFn(id, data);
            setSaved((prev) => new Set(prev).add(id));
            setTimeout(() => setSaved((prev) => { const n = new Set(prev); n.delete(id); return n; }), 2000);
          } catch { /* ignore */ }
        }, delay)
      );
    },
    [saveFn, delay]
  );

  return { trigger, saved };
}

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

/* ─── Rule Row (with toggle) ─── */
function RuleRow({ rule, onSave, hideToggle }: { rule: PricingRule; onSave: (id: number, data: any) => void; hideToggle?: boolean }) {
  const [value, setValue] = useState(String(rule.value));
  const [active, setActive] = useState(rule.is_active);

  useEffect(() => { setValue(String(rule.value)); setActive(rule.is_active); }, [rule]);

  const save = (patch: Partial<{ value: number; is_active: boolean }>) => {
    const name = promptEditorName();
    if (!name) return;
    onSave(rule.id, { value: patch.value ?? parseFloat(value), is_active: patch.is_active ?? active, changed_by: name });
  };

  return (
    <div className="flex items-center gap-3 py-2 px-1 border-b border-border last:border-b-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-1 text-sm text-foreground cursor-default">{rule.label}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p>Changed: {formatDate(rule.changed_at)}</p>
          <p>By: {rule.changed_by ?? "—"}</p>
        </TooltipContent>
      </Tooltip>
      <Input
        type="number"
        className="w-24 h-8 text-sm"
        value={value}
        onChange={(e) => { setValue(e.target.value); const v = parseFloat(e.target.value); if (!isNaN(v)) save({ value: v }); }}
      />
      {rule.suffix && <span className="text-xs text-muted-foreground w-10">{rule.suffix}</span>}
      {!hideToggle && <Switch checked={active} onCheckedChange={(v) => { setActive(v); save({ is_active: v }); }} />}
    </div>
  );
}

/* ─── Rules Card ─── */
function RulesCard({ title, rules, onSave, saved, hideToggle }: { title: string; rules: PricingRule[]; onSave: (id: number, data: any) => void; saved: Set<number>; hideToggle?: boolean }) {
  return (
    <Card className="flex-1">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          {title}
          {rules.some((r) => saved.has(r.id)) && <Check className="h-4 w-4 text-green-400" />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rules.map((r) => (
          <RuleRow key={r.id} rule={r} onSave={onSave} hideToggle={hideToggle} />
        ))}
        {rules.length === 0 && <p className="text-sm text-muted-foreground">No rules found.</p>}
      </CardContent>
    </Card>
  );
}

/* ─── Range Table with cascade preview ─── */
function RangeTable({ ranges, onSave, saved }: { ranges: PricingRange[]; onSave: (id: number, data: any) => void; saved: Set<number> }) {
  const sorted = [...ranges].sort((a, b) => a.range_min - b.range_min);
  const [localMagics, setLocalMagics] = useState<Map<number, string>>(new Map());
  const [editingIds, setEditingIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    setLocalMagics(new Map());
    setEditingIds(new Set());
  }, [ranges]);

  const getMagic = (r: PricingRange) => {
    const local = localMagics.get(r.id);
    if (local !== undefined) return parseFloat(local) || r.magic_number;
    return r.magic_number;
  };

  // Cascade preview calculation
  const previews = useMemo(() => {
    const result = new Map<number, { lower: number; upper: number | null }>();
    let prevUpper = 0;
    for (const r of sorted) {
      if (r.fixed_sek !== null) {
        result.set(r.id, { lower: r.fixed_sek, upper: null });
        prevUpper = r.fixed_sek;
        continue;
      }
      const m = getMagic(r);
      const lower = Math.max(roundTo5(r.range_min * EUR_SEK_RATE * m), prevUpper);
      const upper = r.range_max !== null ? roundTo5(r.range_max * EUR_SEK_RATE * m) : null;
      result.set(r.id, { lower, upper });
      prevUpper = upper ?? lower;
    }
    return result;
  }, [sorted, localMagics]);

  const handleMagicChange = (id: number, val: string) => {
    setLocalMagics((prev) => new Map(prev).set(id, val));
    setEditingIds((prev) => new Set(prev).add(id));
    const v = parseFloat(val);
    if (!isNaN(v)) {
      const name = promptEditorName();
      if (!name) return;
      const r = sorted.find((r) => r.id === id);
      if (r) onSave(id, { magic_number: v, fixed_sek: r.fixed_sek, is_active: r.is_active, changed_by: name });
    }
  };

  const isPreview = editingIds.size > 0;

  return (
    <Card className="flex-1">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          EUR → SEK Price Table
          {ranges.some((r) => saved.has(r.id)) && <Check className="h-4 w-4 text-green-400" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2 pr-3">EUR Range</th>
              <th className="py-2 pr-3">Magic Number</th>
              <th className="py-2 pr-3">Price Range (SEK)</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const rangeLabel = r.range_max !== null
                ? `€${r.range_min.toFixed(2)} – €${r.range_max.toFixed(2)}`
                : `€${r.range_min.toFixed(2)} +`;

              const preview = previews.get(r.id);
              const apiLower = r.display_lower_sek;
              const apiUpper = r.display_upper_sek;

              // Determine displayed price range
              let priceLabel: string;
              let isPreviewStyle = false;

              if (r.fixed_sek !== null) {
                priceLabel = `${r.fixed_sek} SEK min`;
              } else if (isPreview && preview) {
                isPreviewStyle = true;
                priceLabel = preview.upper !== null
                  ? `${preview.lower} – ${preview.upper} SEK`
                  : `${preview.lower}+ SEK`;
              } else if (apiLower !== null && apiLower !== undefined) {
                priceLabel = apiUpper !== null && apiUpper !== undefined
                  ? `${apiLower} – ${apiUpper} SEK`
                  : `${apiLower}+ SEK`;
              } else {
                priceLabel = "—";
              }

              const magicVal = localMagics.get(r.id) ?? String(r.magic_number);

              return (
                <Tooltip key={r.id}>
                  <TooltipTrigger asChild>
                    <tr className="border-b border-border last:border-b-0">
                      <td className="py-2 pr-3 text-foreground whitespace-nowrap">{rangeLabel}</td>
                      <td className="py-2 pr-3">
                        <Input
                          type="number"
                          className="w-20 h-7 text-sm"
                          value={magicVal}
                          onChange={(e) => handleMagicChange(r.id, e.target.value)}
                        />
                      </td>
                      <td className={`py-2 pr-3 whitespace-nowrap ${isPreviewStyle ? "italic text-muted-foreground/70" : "text-muted-foreground"}`}>
                        {priceLabel}
                      </td>
                    </tr>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <p>Changed: {formatDate(r.changed_at)}</p>
                    <p>By: {r.changed_by ?? "—"}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </tbody>
        </table>
        {ranges.length === 0 && <p className="text-sm text-muted-foreground mt-2">No ranges found.</p>}
      </CardContent>
    </Card>
  );
}

/* ─── Audit Log ─── */
function AuditLog() {
  const { data, isLoading, isError, refetch } = useQuery<AuditEntry[]>({
    queryKey: ["pricing-audit"],
    queryFn: fetchPricingAudit,
    staleTime: 10000,
  });

  const entries = Array.isArray(data) ? data : [];

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base">Change Log</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()} className="h-8 gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {isError && <p className="text-sm text-destructive">Failed to load audit log.</p>}
        {!isLoading && !isError && entries.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">No changes recorded yet.</p>
        )}
        {!isLoading && !isError && entries.length > 0 && (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Who</th>
                  <th className="py-2 pr-4">Section</th>
                  <th className="py-2 pr-4">Rule</th>
                  <th className="py-2">New Value</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-b-0">
                    <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                      {formatDistanceToNow(new Date(e.changed_at), { addSuffix: true })}
                    </td>
                    <td className="py-2 pr-4">{e.changed_by}</td>
                    <td className="py-2 pr-4">{e.section}</td>
                    <td className="py-2 pr-4">{e.rule_label}</td>
                    <td className="py-2">{e.new_value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Restore Defaults Button ─── */
function RestoreDefaultsButton({ onSuccess }: { onSuccess: () => void }) {
  const [resetting, setResetting] = useState(false);

  const handleConfirm = async () => {
    const name = promptEditorName();
    if (!name) return;
    setResetting(true);
    try {
      await resetPricingDefaults(name);
      onSuccess();
      toast({ title: "Pricing restored to defaults.", className: "bg-green-900 border-green-700 text-green-100" });
    } catch (err: any) {
      toast({ title: "Reset failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setResetting(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={resetting} className="gap-1.5">
          {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          Restore defaults
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore defaults?</AlertDialogTitle>
          <AlertDialogDescription>
            This will reset all pricing rules and ranges to their original values. Continue?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ─── Main Page ─── */
export default function Pricing() {
  const qc = useQueryClient();

  const { data: rulesData, isLoading: rulesLoading, isError: rulesError } = useQuery<PricingRulesResponse>({
    queryKey: ["pricing-rules"],
    queryFn: fetchPricingRules,
    staleTime: 30000,
  });

  const { data: ranges, isLoading: rangesLoading, isError: rangesError } = useQuery<PricingRange[]>({
    queryKey: ["pricing-ranges"],
    queryFn: fetchPricingRanges,
    staleTime: 30000,
  });

  const ruleSave = useDebouncedSave<any>(async (id, data) => {
    await updatePricingRule(id, data);
    qc.invalidateQueries({ queryKey: ["pricing-rules"] });
  });

  const rangeSave = useDebouncedSave<any>(async (id, data) => {
    await updatePricingRange(id, data);
    qc.invalidateQueries({ queryKey: ["pricing-ranges"] });
  });

  const buyValuation = rulesData?.buy_valuation ?? [];
  const buyMultiplier = rulesData?.buy_multiplier ?? [];
  const sellCondition = rulesData?.sell_condition ?? [];
  const sellMinimum = rulesData?.sell_minimum ?? [];
  const safeRanges = Array.isArray(ranges) ? ranges : [];

  const isLoading = rulesLoading || rangesLoading;
  const hasError = rulesError || rangesError;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <StoreHeader />
      <main className="container py-6 space-y-4">
        <div className="rounded-md border border-muted bg-muted/30 px-4 py-2.5 text-sm text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4 shrink-0" />
          Changes take effect within 60 seconds.
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-20 gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading pricing data…
          </div>
        )}

        {hasError && !isLoading && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Failed to load pricing data. Please refresh the page.
          </div>
        )}

        {!isLoading && !hasError && (
          <Tabs defaultValue="buy">
            <div className="flex items-center justify-between gap-4">
              <TabsList>
                <TabsTrigger value="buy">Buy Rules</TabsTrigger>
                <TabsTrigger value="sell">Sell Rules</TabsTrigger>
                <TabsTrigger value="log">Change Log</TabsTrigger>
              </TabsList>
              <RestoreDefaultsButton onSuccess={() => {
                qc.invalidateQueries({ queryKey: ["pricing-rules"] });
                qc.invalidateQueries({ queryKey: ["pricing-ranges"] });
                qc.invalidateQueries({ queryKey: ["pricing-audit"] });
              }} />
            </div>

            <TabsContent value="buy" className="mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <RulesCard title="Valuation Rules" rules={buyValuation} onSave={ruleSave.trigger} saved={ruleSave.saved} />
                <RulesCard title="Trade Type Multipliers" rules={buyMultiplier} onSave={ruleSave.trigger} saved={ruleSave.saved} />
              </div>
            </TabsContent>

            <TabsContent value="sell" className="mt-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <RangeTable ranges={safeRanges} onSave={rangeSave.trigger} saved={rangeSave.saved} />
                <RulesCard title="Sell Condition Discounts" rules={sellCondition} onSave={ruleSave.trigger} saved={ruleSave.saved} hideToggle />
              </div>
              <RulesCard title="Minimum Prices" rules={sellMinimum} onSave={ruleSave.trigger} saved={ruleSave.saved} hideToggle />
            </TabsContent>

            <TabsContent value="log" className="mt-4">
              <AuditLog />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}
