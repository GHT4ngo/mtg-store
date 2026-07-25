import { useState, useCallback, useRef, useEffect } from "react";
import { Search, Loader2, Check, PackagePlus, AlertTriangle, ChevronDown, ChevronUp, MonitorPlay, Pencil, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { toast } from "sonner";
import StoreHeader from "@/components/StoreHeader";
import CardImageHover from "@/components/CardImageHover";
import {
  lookupTradeIn,
  importTradeInToStock,
  updateTradeInRow,
  fetchCardOptions,
  type TradeInSession,
  type TradeInRow,
  type CardSetOption,
  type CardPrintingOption,
} from "@/lib/tradeinApi";
import { fetchImportStatus, verifyImport, confirmImportAsync, type ImportVerifyResponse } from "@/lib/importApi";

type ImportState = "idle" | "importing" | "done" | "error";

import { CONDITION_OPTIONS, conditionLabel } from "@/lib/conditions";

/** Normalise foil from API — handles both boolean and string */
function isFoil(val: unknown): boolean {
  if (typeof val === "string") return val === "foil";
  return !!val;
}

export default function TradeInLookupPage() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<TradeInSession | null>(null);

  // Import-to-stock async state
  const [importState, setImportState] = useState<ImportState>("idle");
  const [appliedCount, setAppliedCount] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [verifyResult, setVerifyResult] = useState<ImportVerifyResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [importId, setImportId] = useState<number | null>(null);
  const [failedExpanded, setFailedExpanded] = useState(false);
  const [backgroundBanner, setBackgroundBanner] = useState<{ importId: number } | null>(null);
  const [pendingVerifyResult, setPendingVerifyResult] = useState<ImportVerifyResponse | null>(null);
  const [showPendingRows, setShowPendingRows] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Per-row saving indicator
  const [savingRowField, setSavingRowField] = useState<string | null>(null);

  // Set/printing picker state (for the currently editing row)
  const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
  const [setOptions, setSetOptions] = useState<CardSetOption[]>([]);
  const [setOptionsLoading, setSetOptionsLoading] = useState(false);
  const [setPickerOpen, setSetPickerOpen] = useState(false);
  const [setSearch, setSetSearch] = useState("");
  const [printingOptions, setPrintingOptions] = useState<CardPrintingOption[]>([]);
  const [printingLoading, setPrintingLoading] = useState(false);
  const [printingPickerOpen, setPrintingPickerOpen] = useState(false);

  const isEditable = session?.status === "pending";

  const handleLookup = useCallback(async () => {
    if (!token.trim()) return;
    setLoading(true);
    setSession(null);
    setImportState("idle");
    setVerifyResult(null);
    setEditingRowIndex(null);
    try {
      const data = await lookupTradeIn(token.trim());
      setSession(data);
    } catch {
      toast.error("Trade-in not found. Check your token.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const startPolling = useCallback((id: number, totalRows: number) => {
    stopPolling();
    setImportState("importing");
    setImportId(id);
    setRowCount(totalRows);
    setAppliedCount(0);
    setVerifyResult(null);
    setErrorMsg("");
    setBackgroundBanner(null);

    pollRef.current = setInterval(async () => {
      try {
        const status = await fetchImportStatus(id);
        setAppliedCount(status.applied_count ?? 0);
        setRowCount(status.row_count ?? totalRows);

        if (status.status === "confirmed") {
          stopPolling();
          try {
            const vr = await verifyImport(id);
            setVerifyResult(vr);
            setImportState("done");
          } catch {
            setErrorMsg("Import completed but verification failed.");
            setImportState("error");
          }
        } else if (status.status === "pending" || status.status === "failed") {
          stopPolling();
          setErrorMsg("Import is still processing. This can happen when cards are not yet in our catalog (e.g. a newly released set).");
          setImportState("error");
          try {
            const vr = await verifyImport(id);
            setPendingVerifyResult(vr);
          } catch {
            setPendingVerifyResult(null);
          }
        } else if (status.status !== "confirming") {
          stopPolling();
          setErrorMsg(`Unexpected status: ${status.status}`);
          setImportState("error");
        }
      } catch {
        stopPolling();
        setErrorMsg("Lost connection while polling status.");
        setImportState("error");
      }
    }, 2000);
  }, []);

  const handleRunInBackground = useCallback(() => {
    stopPolling();
    if (importId) {
      setBackgroundBanner({ importId });
    }
    setImportState("idle");
  }, [importId]);

  const handleImportToStock = useCallback(async () => {
    if (!session) return;
    setImportState("importing");
    setAppliedCount(0);
    setVerifyResult(null);
    setErrorMsg("");

    try {
      const res = await importTradeInToStock(session.token);
      if (res.status === "confirmed") {
        setImportId(res.import_id);
        setRowCount(res.row_count);
        setAppliedCount(res.row_count);
        try {
          const vr = await verifyImport(res.import_id);
          setVerifyResult(vr);
          setImportState("done");
        } catch {
          setImportState("done");
          setVerifyResult({ status: "ok", verified_count: res.row_count, failed_count: 0, rows: [] });
        }
      } else {
        startPolling(res.import_id, res.row_count);
      }
    } catch {
      setErrorMsg("Failed to start import.");
      setImportState("error");
    }
  }, [session, startPolling]);

  // --- Per-field PUT helper ---
  const putRowField = async (rowIndex: number, body: Record<string, unknown>) => {
    if (!session) return;
    const row = session.rows[rowIndex];
    const rowId = row.row_id ?? row.id;
    if (!rowId) {
      toast.error("Row has no ID — cannot update");
      return;
    }
    const fieldKey = `${rowIndex}-${Object.keys(body).join(",")}`;
    setSavingRowField(fieldKey);
    try {
      const resp = await updateTradeInRow(session.token, rowId, body);
      setSession(s => {
        if (!s) return s;
        const updated = [...s.rows];
        updated[rowIndex] = {
          ...updated[rowIndex],
          ...body as Partial<TradeInRow>,
          tradein_final_sek: resp.tradein_final_sek,
          tradein_total_sek: resp.tradein_total_sek,
          price_trend_eur: resp.price_trend_eur,
          multiplier_notes: resp.multiplier_notes,
          missing_price: resp.missing_price,
          over_threshold: resp.over_threshold,
        };
        return { ...s, rows: updated, total_value_sek: resp.session_total_sek };
      });
    } catch (err: any) {
      if (err?.status === 404) {
        toast.error("Could not find row — refresh and try again.");
      } else {
        toast.error("Failed to update row");
      }
    } finally {
      setSavingRowField(null);
    }
  };

  // --- Set/Printing picker helpers ---
  const openSetPicker = async (cardName: string, rowIndex: number) => {
    setEditingRowIndex(rowIndex);
    setSetOptionsLoading(true);
    setSetPickerOpen(true);
    setSetSearch("");
    try {
      const opts = await fetchCardOptions(cardName) as CardSetOption[];
      opts.sort((a, b) => b.released_at.localeCompare(a.released_at));
      setSetOptions(opts);
    } catch {
      toast.error("Failed to load set options");
      setSetPickerOpen(false);
    } finally {
      setSetOptionsLoading(false);
    }
  };

  const selectSet = async (opt: CardSetOption, cardName: string, rowIndex: number) => {
    setSetPickerOpen(false);
    setPrintingLoading(true);
    setPrintingPickerOpen(true);
    setEditingRowIndex(rowIndex);
    try {
      const prints = await fetchCardOptions(cardName, opt.set_code) as CardPrintingOption[];
      setPrintingOptions(prints);
      // Store selected set temporarily for use in selectPrinting
      setSetOptions(prev => {
        // Tag the selected set for reference
        return prev;
      });
      // We need to pass set info through to selectPrinting, store in a ref-like pattern
      (selectSet as any)._pendingSet = opt;
    } catch {
      toast.error("Failed to load printings");
      setPrintingPickerOpen(false);
    } finally {
      setPrintingLoading(false);
    }
  };

  const selectPrinting = async (p: CardPrintingOption, rowIndex: number, setOpt?: CardSetOption) => {
    setPrintingPickerOpen(false);
    setPrintingOptions([]);
    const pendingSet = setOpt || (selectSet as any)._pendingSet as CardSetOption | undefined;
    const body: Record<string, unknown> = {
      scryfall_id: p.scryfall_id,
      collector_number: p.collector_number,
    };
    if (pendingSet) {
      body.set_code = pendingSet.set_code;
      body.set_name = pendingSet.set_name;
    }
    await putRowField(rowIndex, body);
    // Also update the image locally
    setSession(s => {
      if (!s) return s;
      const updated = [...s.rows];
      updated[rowIndex] = { ...updated[rowIndex], image_url_small: p.image_url_small };
      if (pendingSet) {
        updated[rowIndex].set_code = pendingSet.set_code;
        updated[rowIndex].set_name = pendingSet.set_name;
      }
      updated[rowIndex].collector_number = p.collector_number;
      updated[rowIndex].scryfall_id = p.scryfall_id;
      return { ...s, rows: updated };
    });
    (selectSet as any)._pendingSet = undefined;
    setEditingRowIndex(null);
  };

  const openPrintingPicker = async (cardName: string, setCode: string, rowIndex: number) => {
    setEditingRowIndex(rowIndex);
    setPrintingLoading(true);
    setPrintingPickerOpen(true);
    try {
      const prints = await fetchCardOptions(cardName, setCode) as CardPrintingOption[];
      setPrintingOptions(prints);
    } catch {
      toast.error("Failed to load printings");
      setPrintingPickerOpen(false);
    } finally {
      setPrintingLoading(false);
    }
  };

  const filteredSetOptions = setSearch
    ? setOptions.filter(o =>
        o.set_name.toLowerCase().includes(setSearch.toLowerCase()) ||
        o.set_code.toLowerCase().includes(setSearch.toLowerCase())
      )
    : setOptions;

  const tradeTypeLabel =
    session?.trade_type === "trade_cards"
      ? "MTG Cards"
      : session?.trade_type === "trade_products"
      ? "Other Products"
      : "Cash";

  const progressPct = rowCount > 0 ? Math.round((appliedCount / rowCount) * 100) : 0;

  return (
    <div className="min-h-screen bg-background">
      <StoreHeader />
      <main className="container max-w-5xl space-y-6 py-6">
        <h2 className="text-2xl font-display font-bold text-foreground">Check Trade-In</h2>

        <div className="flex items-center gap-3">
          <Input
            placeholder="Enter your token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            className="max-w-xs font-mono"
          />
          <Button onClick={handleLookup} disabled={loading || !token.trim()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            <span className="ml-1">Look up</span>
          </Button>
        </div>

        {session && (
          <div className="space-y-4">
            {/* Summary card */}
            <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Value</p>
                  <p className="text-2xl font-bold text-foreground">{session.total_value_sek} kr</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Trade Type</p>
                  <p className="text-lg font-semibold text-foreground">{tradeTypeLabel}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Customer Email</p>
                  <p className="text-sm font-medium text-foreground break-all">{session.email}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Status</p>
                  <Badge
                    className={`mt-1 ${
                      session.status === "submitted"
                        ? "border-green-600/30 bg-green-600/20 text-green-500"
                        : ""
                    }`}
                    variant="secondary"
                  >
                    {session.status}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">
                  Token: <code className="font-mono font-medium text-primary">{session.token}</code>
                  {" · "}Created: {new Date(session.created_at).toLocaleString("sv-SE")}
                </p>
                {importState === "idle" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={handleImportToStock}
                  >
                    <PackagePlus className="h-3 w-3" />
                    Import to Stock
                  </Button>
                )}
              </div>
            </div>

            {/* Background banner */}
            {backgroundBanner && importState === "idle" && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex items-center justify-between">
                <p className="text-sm text-foreground">
                  Import <code className="font-mono font-medium text-primary">#{backgroundBanner.importId}</code> is running in the background.
                </p>
                <Button variant="ghost" size="sm" onClick={() => setBackgroundBanner(null)}>
                  Dismiss
                </Button>
              </div>
            )}

            {/* Import progress */}
            {importState === "importing" && (
              <div className="rounded-lg border border-border bg-card p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm font-medium text-foreground">Importing to stock...</span>
                  </div>
                  <Button variant="outline" size="sm" className="gap-1" onClick={handleRunInBackground}>
                    <MonitorPlay className="h-3 w-3" />
                    Run in background
                  </Button>
                </div>
                <Progress value={progressPct} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  Processing... {appliedCount} / {rowCount} cards
                </p>
              </div>
            )}

            {/* Import error */}
            {importState === "error" && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <span className="text-sm font-medium text-foreground">{errorMsg}</span>
                </div>
                {importId && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowPendingRows(!showPendingRows)}
                    >
                      {showPendingRows ? "Hide" : "View"} import rows
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={retrying}
                      onClick={async () => {
                        setRetrying(true);
                        try {
                          await confirmImportAsync(importId);
                          setPendingVerifyResult(null);
                          setShowPendingRows(false);
                          startPolling(importId, rowCount);
                        } catch {
                          toast.error("Retry failed");
                        } finally {
                          setRetrying(false);
                        }
                      }}
                    >
                      {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Retry import
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setImportState("idle"); setPendingVerifyResult(null); setShowPendingRows(false); }}>
                      Dismiss
                    </Button>
                  </div>
                )}
                {!importId && (
                  <Button variant="outline" size="sm" onClick={() => setImportState("idle")}>
                    Dismiss
                  </Button>
                )}

                {showPendingRows && pendingVerifyResult && (
                  <div className="max-h-[40vh] overflow-auto rounded-lg border border-border mt-2">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-secondary/50">
                          <TableHead className="text-xs">Card</TableHead>
                          <TableHead className="text-xs">Reference</TableHead>
                          <TableHead className="text-xs">Condition</TableHead>
                          <TableHead className="text-xs text-right">Expected</TableHead>
                          <TableHead className="text-xs text-right">Actual</TableHead>
                          <TableHead className="text-xs">Issue</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingVerifyResult.rows.map((r, i) => (
                          <TableRow key={i} className={r.verified ? "" : "bg-destructive/5"}>
                            <TableCell className="text-xs">{r.name}</TableCell>
                            <TableCell className="text-xs font-mono">{r.actual_ref ?? r.reference ?? "–"}</TableCell>
                            <TableCell className="text-xs">{r.condition ?? "–"}</TableCell>
                            <TableCell className="text-xs text-right">{r.expected_stock}</TableCell>
                            <TableCell className="text-xs text-right font-medium">{r.actual_stock}</TableCell>
                            <TableCell className="text-xs text-destructive">{r.issue ?? (r.verified ? "OK" : "–")}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {showPendingRows && !pendingVerifyResult && (
                  <p className="text-xs text-muted-foreground mt-1">No verification data available yet.</p>
                )}
              </div>
            )}

            {/* Import done — verify results */}
            {importState === "done" && verifyResult && (
              <div className="space-y-3">
                {verifyResult.failed_count === 0 ? (
                  <div className="rounded-lg border border-green-600/30 bg-green-600/10 p-4 flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-600/20">
                      <Check className="h-5 w-5 text-green-500" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        ✓ {verifyResult.verified_count} cards imported successfully
                      </p>
                      <p className="text-xs text-muted-foreground">All cards verified against stock.</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-500/20">
                        <AlertTriangle className="h-5 w-5 text-yellow-500" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          ⚠️ {verifyResult.verified_count} OK, {verifyResult.failed_count} failed
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setFailedExpanded(!failedExpanded)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {failedExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      {failedExpanded ? "Hide" : "Show"} failed cards
                    </button>
                    {failedExpanded && verifyResult.rows.length > 0 && (
                      <div className="max-h-[30vh] overflow-auto rounded-lg border border-border">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-secondary/50">
                              <TableHead className="text-xs">Card</TableHead>
                              <TableHead className="text-xs">Reference</TableHead>
                              <TableHead className="text-xs">Condition</TableHead>
                              <TableHead className="text-xs">Expected</TableHead>
                              <TableHead className="text-xs">Actual</TableHead>
                              <TableHead className="text-xs">Issue</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {verifyResult.rows
                              .filter((r) => r.issue)
                              .map((r, i) => (
                                <TableRow key={i}>
                                  <TableCell className="text-xs">{r.name}</TableCell>
                                  <TableCell className="text-xs font-mono text-muted-foreground">{r.reference}</TableCell>
                                  <TableCell className="text-xs">{r.condition}</TableCell>
                                  <TableCell className="text-xs">{r.expected_stock}</TableCell>
                                  <TableCell className="text-xs">{r.actual_stock}</TableCell>
                                  <TableCell className="text-xs text-destructive">{r.issue}</TableCell>
                                </TableRow>
                              ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Row table — inline editable when status=pending */}
            <div className="max-h-[55vh] overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/50">
                    <TableHead className="text-xs">Set</TableHead>
                    <TableHead className="text-xs text-right">#</TableHead>
                    <TableHead className="text-xs">Card Name</TableHead>
                    <TableHead className="text-xs text-center">Foil</TableHead>
                    <TableHead className="text-xs">Cond</TableHead>
                    <TableHead className="text-xs">Lang</TableHead>
                    <TableHead className="text-xs text-right">Qty</TableHead>
                    <TableHead className="text-xs text-right">Trend (€)</TableHead>
                    <TableHead className="text-xs text-right">Trade Value</TableHead>
                    <TableHead className="text-xs">Notes</TableHead>
                    {isEditable && <TableHead className="w-[40px] text-xs"></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {session.rows.map((row, i) => {
                    const isSavingThis = savingRowField?.startsWith(`${i}-`);

                    return (
                      <TableRow
                        key={`${row.scryfall_id}-${i}`}
                        className={`${row.over_threshold ? "opacity-50" : ""} ${isSavingThis ? "bg-primary/5" : ""}`}
                      >
                        {/* Set */}
                        <TableCell className="text-xs font-mono text-muted-foreground uppercase">
                          {isEditable ? (
                            <Popover open={setPickerOpen && editingRowIndex === i} onOpenChange={(open) => { if (!open) setSetPickerOpen(false); }}>
                              <PopoverTrigger asChild>
                                <button
                                  className="cursor-pointer text-primary text-xs font-mono uppercase hover:underline"
                                  onClick={() => openSetPicker(row.name, i)}
                                >
                                  {row.set_code}
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-64 p-2" align="start">
                                <div className="relative mb-2">
                                  <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                                  <Input
                                    placeholder="Search sets..."
                                    value={setSearch}
                                    onChange={e => setSetSearch(e.target.value)}
                                    className="h-7 pl-7 text-xs"
                                  />
                                </div>
                                <div className="max-h-48 overflow-auto space-y-0.5">
                                  {setOptionsLoading ? (
                                    <div className="flex items-center justify-center py-4">
                                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                    </div>
                                  ) : filteredSetOptions.length === 0 ? (
                                    <p className="py-2 text-center text-xs text-muted-foreground">No sets found</p>
                                  ) : (
                                    filteredSetOptions.map(opt => (
                                      <button
                                        key={opt.set_code}
                                        className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
                                          opt.set_code === row.set_code
                                            ? "bg-primary/10 font-medium text-primary"
                                            : "text-foreground"
                                        }`}
                                        onClick={() => selectSet(opt, row.name, i)}
                                      >
                                        {opt.set_name}{" "}
                                        <span className="font-mono text-muted-foreground uppercase">({opt.set_code})</span>
                                      </button>
                                    ))
                                  )}
                                </div>
                              </PopoverContent>
                            </Popover>
                          ) : (
                            row.set_code
                          )}
                        </TableCell>

                        {/* Collector # */}
                        <TableCell className="text-xs font-mono text-right text-muted-foreground">
                          {isEditable ? (
                            <Popover open={printingPickerOpen && editingRowIndex === i} onOpenChange={(open) => { if (!open) setPrintingPickerOpen(false); }}>
                              <PopoverTrigger asChild>
                                <button
                                  className="cursor-pointer text-primary text-xs font-mono hover:underline"
                                  onClick={() => openPrintingPicker(row.name, row.set_code, i)}
                                >
                                  {row.collector_number || "—"}
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-72 p-2" align="start">
                                {printingLoading ? (
                                  <div className="flex items-center justify-center py-4">
                                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                  </div>
                                ) : printingOptions.length === 0 ? (
                                  <p className="py-2 text-center text-xs text-muted-foreground">No printings found</p>
                                ) : (
                                  <div className="grid grid-cols-3 gap-2 max-h-64 overflow-auto">
                                    {printingOptions.map(p => (
                                      <button
                                        key={p.scryfall_id}
                                        className={`flex flex-col items-center gap-1 rounded p-1.5 transition-colors hover:bg-accent ${
                                          p.scryfall_id === row.scryfall_id
                                            ? "ring-2 ring-primary bg-primary/10"
                                            : ""
                                        }`}
                                        onClick={() => selectPrinting(p, i)}
                                      >
                                        {p.image_url_small ? (
                                          <img
                                            src={p.image_url_small}
                                            alt={`#${p.collector_number}`}
                                            className="h-16 w-12 rounded-sm object-cover"
                                          />
                                        ) : (
                                          <div className="flex h-16 w-12 items-center justify-center rounded-sm bg-secondary text-[10px] text-muted-foreground">
                                            No img
                                          </div>
                                        )}
                                        <span className="text-[10px] font-mono text-muted-foreground">#{p.collector_number}</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </PopoverContent>
                            </Popover>
                          ) : (
                            row.collector_number
                          )}
                        </TableCell>

                        {/* Card name */}
                        <TableCell className="text-xs max-w-[200px]">
                          <div className="flex items-center gap-2">
                            {row.missing_price && (
                              <span title="Missing price"><AlertTriangle className="h-3 w-3 flex-shrink-0 text-yellow-500" /></span>
                            )}
                            {row.image_url_small && (
                              <CardImageHover src={row.image_url_small} alt={row.name}>
                                <img src={row.image_url_small} alt="" className="h-8 w-6 rounded-sm object-cover flex-shrink-0" />
                              </CardImageHover>
                            )}
                            <span className="truncate">{row.name}</span>
                          </div>
                        </TableCell>

                        {/* Foil */}
                        <TableCell className="text-center text-xs">
                          {isEditable ? (
                            <Checkbox
                              checked={isFoil(row.foil)}
                              onCheckedChange={(v) => putRowField(i, { foil: v ? "foil" : "normal" })}
                            />
                          ) : (
                            isFoil(row.foil) ? "✨" : ""
                          )}
                        </TableCell>

                        {/* Condition */}
                        <TableCell className="text-xs">
                          {isEditable ? (
                            <Select
                              value={row.condition}
                              onValueChange={(v) => putRowField(i, { condition: v })}
                            >
                              <SelectTrigger className="h-7 w-[70px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CONDITION_OPTIONS.map(o => (
                                  <SelectItem key={o.value} value={o.value} className="text-xs">{o.value}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">{row.condition ?? "NM"}</Badge>
                          )}
                        </TableCell>

                        {/* Language */}
                        <TableCell className="text-xs">
                          {isEditable ? (
                            <Select
                              value={row.language ?? "EN"}
                              onValueChange={(v) => putRowField(i, { language: v })}
                            >
                              <SelectTrigger className="h-7 w-[60px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {["EN", "FR", "DE", "JA", "IT", "ES", "PT", "RU", "KO", "CS", "CT"].map(l => (
                                  <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-muted-foreground">{row.language ?? "EN"}</span>
                          )}
                        </TableCell>

                        {/* Qty */}
                        <TableCell className="text-xs text-right">
                          {isEditable ? (
                            <Input
                              type="number"
                              min={1}
                              defaultValue={row.quantity}
                              onBlur={(e) => {
                                const val = Math.max(1, parseInt(e.target.value) || 1);
                                if (val !== row.quantity) putRowField(i, { quantity: val });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  (e.target as HTMLInputElement).blur();
                                }
                              }}
                              className="h-7 w-[55px] text-xs text-right"
                            />
                          ) : (
                            row.quantity
                          )}
                        </TableCell>

                        {/* Trend */}
                        <TableCell className="text-xs text-right text-muted-foreground whitespace-nowrap">
                          {row.price_trend_eur != null ? `€${row.price_trend_eur.toFixed(2)}` : "—"}
                        </TableCell>

                        {/* Trade value */}
                        <TableCell className="text-xs text-right font-medium whitespace-nowrap">
                          {isEditable ? (
                            <Input
                              type="number"
                              min={0}
                              defaultValue={row.tradein_final_sek}
                              onBlur={(e) => {
                                const val = Math.max(0, parseFloat(e.target.value) || 0);
                                if (val !== row.tradein_final_sek) putRowField(i, { tradein_final_sek: val });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                              className="h-7 w-[70px] text-xs text-right"
                            />
                          ) : row.over_threshold
                            ? <span className="text-muted-foreground">0 kr <span className="text-[10px]">(over stock)</span></span>
                            : row.tradein_final_sek > 0
                              ? `${(row.tradein_total_sek ?? row.tradein_final_sek * row.quantity)} kr`
                              : "0 kr"
                          }
                        </TableCell>

                        {/* Notes */}
                        <TableCell className="text-xs text-muted-foreground">
                          {row.multiplier_notes ? (
                            row.multiplier_notes.trim().toLowerCase() === "ok" ? (
                              <span className="font-medium text-green-500">OK</span>
                            ) : (
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button className="inline-flex items-center justify-center h-5 w-5 rounded-full border border-primary/40 text-primary text-[10px] font-bold hover:bg-primary/10 transition-colors" title="View notes">
                                    !
                                  </button>
                                </PopoverTrigger>
                                <PopoverContent side="top" className="max-w-xs whitespace-pre-wrap text-xs">
                                  {row.multiplier_notes}
                                </PopoverContent>
                              </Popover>
                            )
                          ) : (
                            "—"
                          )}
                        </TableCell>

                        {/* Saving indicator */}
                        {isEditable && (
                          <TableCell className="text-center">
                            {isSavingThis && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
