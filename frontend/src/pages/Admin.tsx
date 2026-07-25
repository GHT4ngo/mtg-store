import React, { useState, Component, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, Trash2, Search, Pencil, X, AlertTriangle } from "lucide-react";
import StoreHeader from "@/components/StoreHeader";
import {
  fetchMatchStats, fetchUnmatched, saveCorrection, deleteCorrection,
  fetchNoPriceCards, savePriceOverride, fetchCardLookup, fetchPriceOverrides, deletePriceOverride,
  type UnmatchedRow, type CardLookupResult, type PriceOverride,
} from "@/lib/adminApi";

/* ─── Error Boundary ─── */
class AdminErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background text-foreground">
          <StoreHeader />
          <div className="container py-6">
            <Card>
              <CardContent className="py-12 text-center space-y-3">
                <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
                <h2 className="text-lg font-bold text-destructive">Admin tab crashed</h2>
                <p className="text-sm text-muted-foreground">{this.state.error}</p>
                <Button variant="outline" onClick={() => this.setState({ hasError: false, error: "" })}>Try again</Button>
              </CardContent>
            </Card>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ─── Section 1: Match Quality Dashboard ─── */
function MatchQualityDashboard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: stats, isLoading: statsLoading } = useQuery({ queryKey: ["admin-match-stats"], queryFn: fetchMatchStats });
  const { data: unmatched = [], isLoading: unmatchedLoading } = useQuery({ queryKey: ["admin-unmatched"], queryFn: fetchUnmatched });

  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [editSetCode, setEditSetCode] = useState("");
  const [editCollNum, setEditCollNum] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = (row: UnmatchedRow) => {
    setEditingRef(row.reference);
    setEditSetCode(row.corrected_set_code ?? "");
    setEditCollNum(row.corrected_collector_number ?? "");
  };

  const handleSave = async (reference: string) => {
    setSaving(true);
    try {
      await saveCorrection(reference, editSetCode, editCollNum);
      toast({ title: "Correction saved" });
      setEditingRef(null);
      qc.invalidateQueries({ queryKey: ["admin-unmatched"] });
      qc.invalidateQueries({ queryKey: ["admin-match-stats"] });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const handleDelete = async (reference: string) => {
    setSaving(true);
    try {
      await deleteCorrection(reference);
      toast({ title: "Correction deleted" });
      setEditingRef(null);
      qc.invalidateQueries({ queryKey: ["admin-unmatched"] });
      qc.invalidateQueries({ queryKey: ["admin-match-stats"] });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Match Quality Dashboard</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        {statsLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading stats…</div>
        ) : stats ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatBox label="Total Active" value={(stats.total_mysql ?? 0).toLocaleString()} />
            <StatBox label="Matched" value={(stats.matched ?? 0).toLocaleString()} />
            <StatBox label="Unmatched" value={(stats.unmatched ?? 0).toLocaleString()} />
            <StatBox label="Match %" value={`${(stats.match_pct ?? 0).toFixed(1)} %`} highlight />
          </div>
        ) : null}

        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Unmatched Cards</h3>
          {unmatchedLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : unmatched.length === 0 ? (
            <p className="text-sm text-muted-foreground">All cards matched!</p>
          ) : (
            <div className="rounded-md border overflow-auto max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Stock A</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead>Set Code</TableHead>
                    <TableHead>Collector #</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unmatched.map((row) => (
                    <TableRow key={row.reference}>
                      <TableCell className="font-mono text-xs">{row.reference}</TableCell>
                      <TableCell>{row.name}</TableCell>
                      <TableCell className="text-right">{row.stock_a}</TableCell>
                      <TableCell>{row.condition ?? "–"}</TableCell>
                      {editingRef === row.reference ? (
                        <>
                          <TableCell>
                            <Input value={editSetCode} onChange={(e) => setEditSetCode(e.target.value)} className="h-8 w-24" placeholder="e.g. MKM" />
                          </TableCell>
                          <TableCell>
                            <Input value={editCollNum} onChange={(e) => setEditCollNum(e.target.value)} className="h-8 w-20" placeholder="e.g. 42" />
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button size="sm" variant="ghost" onClick={() => setEditingRef(null)} disabled={saving}><X className="h-3.5 w-3.5" /></Button>
                              <Button size="sm" onClick={() => handleSave(row.reference)} disabled={saving}>
                                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                              </Button>
                              {(row.corrected_set_code || row.corrected_collector_number) && (
                                <Button size="sm" variant="destructive" onClick={() => handleDelete(row.reference)} disabled={saving}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="font-mono text-xs">{row.corrected_set_code ?? "–"}</TableCell>
                          <TableCell className="font-mono text-xs">{row.corrected_collector_number ?? "–"}</TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" onClick={() => startEdit(row)}>
                              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                            </Button>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-4 text-center">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`font-bold ${highlight ? "text-2xl text-primary" : "text-xl text-foreground"}`}>{value}</div>
    </div>
  );
}

/* ─── Section 2: Cards With No Price ─── */
function NoPriceCards() {
  const { toast } = useToast();
  const { data: cards = [], isLoading, refetch } = useQuery({ queryKey: ["admin-no-price"], queryFn: fetchNoPriceCards });
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<Record<string, "sek" | "eur">>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const rowKey = (c: { set_code: string; collector_number: string; is_foil: boolean }) =>
    `${c.set_code}-${c.collector_number}-${c.is_foil}`;

  const handleSave = async (card: typeof cards[0]) => {
    const key = rowKey(card);
    const val = parseFloat(prices[key] || "");
    if (isNaN(val) || val <= 0) { toast({ title: "Enter a valid price", variant: "destructive" }); return; }
    const isEur = (units[key] ?? "eur") === "eur";
    setSavingKey(key);
    try {
      await savePriceOverride({
        set_code: card.set_code, collector_number: card.collector_number, is_foil: card.is_foil,
        ...(isEur ? { price_eur: val } : { price_sek: val }),
      });
      toast({ title: "Price saved" });
      setPrices((p) => { const n = { ...p }; delete n[key]; return n; });
      refetch();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setSavingKey(null); }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Cards With No Price</CardTitle></CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">All cards have prices.</p>
        ) : (
          <div className="rounded-md border overflow-auto max-h-[500px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>MySQL Name</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Set</TableHead>
                  <TableHead>Collector #</TableHead>
                  <TableHead>Foil</TableHead>
                  <TableHead>Condition</TableHead>
                  <TableHead className="text-right">Stock A</TableHead>
                  <TableHead>Set Price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cards.map((card) => {
                  const key = rowKey(card);
                  return (
                    <TableRow key={key}>
                      <TableCell className="font-mono text-xs">{card.reference ?? "–"}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate" title={(card as any).mysql_name ?? card.name}>{(card as any).mysql_name ?? card.name}</TableCell>
                      <TableCell>{card.name}</TableCell>
                      <TableCell>{card.set_code}</TableCell>
                      <TableCell className="font-mono text-xs">{card.collector_number}</TableCell>
                      <TableCell>{card.is_foil ? "✦" : "–"}</TableCell>
                      <TableCell>{card.condition ?? "–"}</TableCell>
                      <TableCell className="text-right">{card.stock_a}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <button
                            className="text-[10px] font-semibold w-8 text-center border rounded px-1 py-0.5 hover:bg-muted"
                            onClick={() => setUnits((u) => ({ ...u, [key]: (u[key] ?? "eur") === "eur" ? "sek" : "eur" }))}
                          >{(units[key] ?? "eur").toUpperCase()}</button>
                          <Input
                            className="h-8 w-24"
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            value={prices[key] ?? ""}
                            onChange={(e) => setPrices((p) => ({ ...p, [key]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && handleSave(card)}
                          />
                          <Button size="sm" variant="outline" onClick={() => handleSave(card)} disabled={savingKey === key}>
                            {savingKey === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Section 3: Price Override by Coordinates ─── */
function PriceOverrideSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [setCode, setSetCode] = useState("");
  const [collNum, setCollNum] = useState("");
  const [isFoil, setIsFoil] = useState(false);
  const [lookupResult, setLookupResult] = useState<CardLookupResult | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const [overrideMode, setOverrideMode] = useState<"fixed_sek" | "fixed_eur" | "percent">("fixed_eur");
  const [fixedPrice, setFixedPrice] = useState("");
  const [percentIncrease, setPercentIncrease] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);

  const { data: overrides = [], isLoading: overridesLoading } = useQuery({ queryKey: ["admin-price-overrides"], queryFn: fetchPriceOverrides });

  const handleLookup = async () => {
    if (!setCode || !collNum) return;
    setLookingUp(true);
    try {
      const result = await fetchCardLookup(setCode, collNum);
      setLookupResult(result);
    } catch (e: any) {
      toast({ title: "Not found", description: e.message, variant: "destructive" });
      setLookupResult(null);
    } finally { setLookingUp(false); }
  };

  const handleSaveOverride = async () => {
    if (!lookupResult) return;
    setSavingOverride(true);
    try {
      const body: any = { set_code: setCode, collector_number: collNum, is_foil: isFoil };
      if (overrideMode === "fixed_sek") {
        const val = parseFloat(fixedPrice);
        if (isNaN(val) || val <= 0) { toast({ title: "Enter a valid price", variant: "destructive" }); setSavingOverride(false); return; }
        body.price_sek = val;
      } else if (overrideMode === "fixed_eur") {
        const val = parseFloat(fixedPrice);
        if (isNaN(val) || val <= 0) { toast({ title: "Enter a valid price", variant: "destructive" }); setSavingOverride(false); return; }
        body.price_eur = val;
      } else {
        const val = parseFloat(percentIncrease);
        if (isNaN(val)) { toast({ title: "Enter a valid percentage", variant: "destructive" }); setSavingOverride(false); return; }
        body.percent_increase = val;
      }
      const result = await savePriceOverride(body);
      toast({ title: "Override saved", description: result?.price_sek ? `Price: ${result.price_sek} SEK` : undefined });
      qc.invalidateQueries({ queryKey: ["admin-price-overrides"] });
      setFixedPrice("");
      setPercentIncrease("");
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setSavingOverride(false); }
  };

  const handleDeleteOverride = async (o: PriceOverride) => {
    try {
      await deletePriceOverride(o.set_code, o.collector_number, o.is_foil);
      toast({ title: "Override deleted" });
      qc.invalidateQueries({ queryKey: ["admin-price-overrides"] });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Price Override by Coordinates</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Set Code</label>
            <Input className="h-9 w-28" value={setCode} onChange={(e) => setSetCode(e.target.value)} placeholder="e.g. MKM" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Collector #</label>
            <Input className="h-9 w-24" value={collNum} onChange={(e) => setCollNum(e.target.value)} placeholder="e.g. 42" />
          </div>
          <div className="flex items-center gap-2 pb-1">
            <Checkbox id="foil-check" checked={isFoil} onCheckedChange={(v) => setIsFoil(!!v)} />
            <label htmlFor="foil-check" className="text-sm">Foil</label>
          </div>
          <Button onClick={handleLookup} disabled={lookingUp || !setCode || !collNum}>
            {lookingUp ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />} Look Up
          </Button>
        </div>

        {lookupResult && (
          <div className="flex gap-4 items-start p-4 rounded-lg border bg-muted/30">
            <img src={lookupResult.image_url_small} alt={lookupResult.name} className="w-20 rounded" />
            <div className="space-y-1">
              <div className="font-medium">{lookupResult.name}</div>
              <div className="text-sm text-muted-foreground">{lookupResult.set_name}</div>
              <div className="text-sm">
                Current price: <span className="font-medium">
                  {(isFoil ? lookupResult.sell_price_foil_sek : lookupResult.sell_price_sek)
                    ? `${isFoil ? lookupResult.sell_price_foil_sek : lookupResult.sell_price_sek} SEK`
                    : "–"}
                </span>
              </div>
            </div>
          </div>
        )}

        {lookupResult && (
          <div className="space-y-3">
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="override-mode" checked={overrideMode === "fixed_eur"} onChange={() => setOverrideMode("fixed_eur")} className="accent-primary" />
                Fixed price (EUR)
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="override-mode" checked={overrideMode === "fixed_sek"} onChange={() => setOverrideMode("fixed_sek")} className="accent-primary" />
                Fixed price (SEK)
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="override-mode" checked={overrideMode === "percent"} onChange={() => setOverrideMode("percent")} className="accent-primary" />
                % increase over current
              </label>
            </div>
            <div className="flex items-center gap-2">
              {overrideMode === "fixed_eur" ? (
                <Input className="h-9 w-32" type="number" step="0.01" placeholder="Price in EUR" value={fixedPrice} onChange={(e) => setFixedPrice(e.target.value)} />
              ) : overrideMode === "fixed_sek" ? (
                <Input className="h-9 w-32" type="number" step="0.01" placeholder="Price in SEK" value={fixedPrice} onChange={(e) => setFixedPrice(e.target.value)} />
              ) : (
                <Input className="h-9 w-32" type="number" step="0.1" placeholder="e.g. 10" value={percentIncrease} onChange={(e) => setPercentIncrease(e.target.value)} />
              )}
              <Button onClick={handleSaveOverride} disabled={savingOverride}>
                {savingOverride ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Save Override
              </Button>
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Existing Overrides</h3>
          {overridesLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : overrides.length === 0 ? (
            <p className="text-sm text-muted-foreground">No overrides set.</p>
          ) : (
            <div className="rounded-md border overflow-auto max-h-[400px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Card</TableHead>
                    <TableHead>Set</TableHead>
                    <TableHead>Collector #</TableHead>
                    <TableHead>Foil</TableHead>
                    <TableHead className="text-right">Override Price</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overrides.map((o) => (
                    <TableRow key={`${o.set_code}-${o.collector_number}-${o.is_foil}`}>
                      <TableCell>{o.name ?? "–"}</TableCell>
                      <TableCell>{o.set_name ?? o.set_code}</TableCell>
                      <TableCell className="font-mono text-xs">{o.collector_number}</TableCell>
                      <TableCell>{o.is_foil ? "✦" : "–"}</TableCell>
                      <TableCell className="text-right font-medium">{o.price_sek} SEK</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{o.updated_at ?? "–"}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="destructive" onClick={() => handleDeleteOverride(o)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Main Admin Page ─── */
export default function Admin() {
  return (
    <AdminErrorBoundary>
      <div className="min-h-screen bg-background text-foreground">
        <StoreHeader />
        <div className="container py-6 space-y-6">
          <h2 className="text-xl font-bold">Admin</h2>
          <MatchQualityDashboard />
          <NoPriceCards />
          <PriceOverrideSection />
        </div>
      </div>
    </AdminErrorBoundary>
  );
}
