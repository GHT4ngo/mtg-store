import { useState, useEffect, useCallback, useRef, useMemo, type KeyboardEvent } from "react";
import { X, Loader2, Plus, Sparkles, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { toast } from "sonner";
import { fetchSets, type SetInfo } from "@/lib/api";
import CardImageHover from "@/components/CardImageHover";
import {
  fetchBulkSetCards,
  confirmBulkImport,
  fetchImportStatus,
  verifyImport,
  type BulkSetCard,
  type BulkConfirmRow,
  type ImportVerifyResponse,
  type ImportStatusResponse,
} from "@/lib/importApi";

interface EditableRow {
  _key: string;
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
  condition: string;
  foil: boolean;
  quantity: number;
}

export interface BulkImportSummaryState {
  importId: number;
  importedCount: number;
  timestamp: string;
  verification: ImportVerifyResponse;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onComplete: (summary: BulkImportSummaryState) => void | Promise<void>;
}

import { CONDITION_OPTIONS } from "@/lib/conditions";

let keyCounter = 0;

function nextKey() {
  return `bulk-${++keyCounter}`;
}

function cardToRow(card: BulkSetCard): EditableRow {
  return {
    _key: nextKey(),
    ...card,
    condition: "NM",
    foil: false,
    quantity: 0,
  };
}

const RARITY_BADGE: Record<string, { letter: string; cls: string }> = {
  common: { letter: "C", cls: "bg-muted text-muted-foreground" },
  uncommon: { letter: "U", cls: "bg-slate-600 text-slate-200" },
  rare: { letter: "R", cls: "bg-amber-600/80 text-amber-100" },
  mythic: { letter: "M", cls: "bg-orange-600 text-orange-100" },
};

export default function BulkSetImport({ open, onClose, onComplete }: Props) {
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [setsLoading, setSetsLoading] = useState(true);
  const [selectedSet, setSelectedSet] = useState("");
  const [setSearch, setSetSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [view, setView] = useState<"idle" | "confirming">("idle");
  const [processingStep, setProcessingStep] = useState<"importing" | "polling" | "verifying">("importing");
  const [polling, setPolling] = useState<{ appliedCount: number; rowCount: number } | null>(null);

  const qtyRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const resetState = useCallback(() => {
    setSelectedSet("");
    setSetSearch("");
    setLoading(false);
    setRows([]);
    setView("idle");
    setProcessingStep("importing");
    setPolling(null);
  }, []);

  useEffect(() => {
    if (!open) {
      resetState();
      return;
    }

    setSetsLoading(true);
    fetchSets()
      .then((result) => {
        setSets(result);
        setSetsLoading(false);
      })
      .catch(() => setSetsLoading(false));
  }, [open, resetState]);

  const filteredSets = useMemo(() => {
    if (!setSearch.trim()) return sets;
    const query = setSearch.toLowerCase();
    return sets.filter((set) => set.set_name.toLowerCase().includes(query) || set.set_code.toLowerCase().includes(query));
  }, [setSearch, sets]);

  const groupedSets = useMemo(() => {
    const groups = new Map<string, SetInfo[]>();

    for (const set of filteredSets) {
      const group = set.set_group || "Other";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)?.push(set);
    }

    for (const list of groups.values()) {
      list.sort((a, b) => a.set_name.localeCompare(b.set_name));
    }

    return groups;
  }, [filteredSets]);

  const handleModalClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const handleSetSelect = useCallback(async (setCode: string) => {
    setSelectedSet(setCode);
    setRows([]);
    setLoading(true);

    try {
      const cards = await fetchBulkSetCards(setCode);
      setRows(cards.map(cardToRow));
    } catch {
      toast.error("Failed to load cards for this set");
    } finally {
      setLoading(false);
    }
  }, []);

  const updateRow = useCallback((key: string, updates: Partial<EditableRow>) => {
    setRows((prev) => prev.map((row) => (row._key === key ? { ...row, ...updates } : row)));
  }, []);

  const duplicateRow = useCallback((key: string) => {
    setRows((prev) => {
      const index = prev.findIndex((row) => row._key === key);
      if (index === -1) return prev;

      const source = prev[index];
      const next = [...prev];
      next.splice(index + 1, 0, { ...source, _key: nextKey(), condition: "NM", foil: false, quantity: 0 });
      return next;
    });
  }, []);

  const getPrice = (row: EditableRow) => {
    const price = row.foil ? row.sell_price_foil_sek : row.sell_price_sek;
    return price && price > 0 ? price : null;
  };

  const activeRows = rows.filter((row) => row.quantity > 0);
  const totalCards = activeRows.reduce((sum, row) => sum + row.quantity, 0);

  const focusQty = (key: string) => {
    setTimeout(() => qtyRefs.current.get(key)?.focus(), 0);
  };

  const handleQtyKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      const targetIndex = event.shiftKey ? index - 1 : index + 1;
      if (targetIndex >= 0 && targetIndex < rows.length) {
        focusQty(rows[targetIndex]._key);
      }
    }
  };

  const handleConfirm = useCallback(async () => {
    if (activeRows.length === 0) return;

    setProcessingStep("importing");
    setPolling(null);
    setView("confirming");

    try {
      const payload: BulkConfirmRow[] = activeRows.map((row) => ({
        scryfall_id: row.scryfall_id,
        reference: row.reference,
        name: row.name,
        set_code: row.set_code,
        set_name: row.set_name,
        collector_number: row.collector_number,
        rarity: row.rarity,
        condition: row.condition,
        foil: row.foil,
        quantity: row.quantity,
        current_stock: row.current_stock,
      }));

      const res = await confirmBulkImport(selectedSet, payload);

      if (!res.import_id) {
        toast.success(`Stock updated! ${res.updated_count} products updated`);
        setView("idle");
        return;
      }

      // Poll for async status
      setProcessingStep("polling");
      setPolling({ appliedCount: 0, rowCount: res.updated_count || activeRows.reduce((s, r) => s + r.quantity, 0) });

      const startTime = Date.now();
      const TIMEOUT = 10 * 60 * 1000;

      const pollStatus = async (): Promise<import("@/lib/importApi").ImportStatusResponse> => {
        return new Promise((resolve, reject) => {
          const interval = setInterval(async () => {
            try {
              const status = await fetchImportStatus(res.import_id);
              setPolling({ appliedCount: status.applied_count, rowCount: status.row_count });

              if (status.status === "confirmed") {
                clearInterval(interval);
                resolve(status);
              } else if (Date.now() - startTime > TIMEOUT) {
                clearInterval(interval);
                reject(new Error("timeout"));
              }
            } catch {
              clearInterval(interval);
              reject(new Error("poll_error"));
            }
          }, 2000);
        });
      };

      try {
        const finalStatus = await pollStatus();
        toast.success(`Stock updated! ${finalStatus.applied_count} products updated`);

        setProcessingStep("verifying");
        setPolling(null);

        setTimeout(async () => {
          try {
            const verification = await verifyImport(res.import_id);
            await onComplete({
              importId: res.import_id,
              importedCount: finalStatus.applied_count,
              timestamp: finalStatus.confirmed_at ?? new Date().toISOString(),
              verification,
            });
          } catch {
            toast.error("Verification failed");
            setView("idle");
          }
        }, 2000);
      } catch (pollErr: any) {
        if (pollErr?.message === "timeout") {
          toast.error("Import is taking longer than expected. You can close this and check the history page — the import will continue running in the background.");
        } else {
          toast.error("Failed to check import status");
        }
        setView("idle");
      }
    } catch {
      toast.error("Bulk confirm failed");
      setView("idle");
    }
  }, [activeRows, onComplete, selectedSet]);

  const getSoldDisplay = (row: EditableRow) => {
    const year = row.sold_last_year_all ?? row.sold_last_year ?? 0;
    const total = row.sold_total_all ?? row.sold_total ?? 0;
    if (year === 0 && total === 0) return "—";
    return `${year} / ${total}`;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3">
        <h2 className="text-lg font-display font-bold text-foreground">Bulk Set Import</h2>
        <Button variant="ghost" size="icon" disabled={view === "confirming"} onClick={handleModalClose}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-4">
        {view === "confirming" ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
            <h3 className="mt-4 text-lg font-semibold text-foreground">
              {processingStep === "verifying" ? "Verifying MySQL..." : "Processing import..."}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {processingStep === "verifying"
                ? "Checking stock values in MySQL..."
                : processingStep === "polling" && polling
                ? `Processing... ${polling.appliedCount} / ${polling.rowCount} cards`
                : "Starting import (this may take a few minutes for large files)"}
            </p>
            {processingStep === "polling" && polling && polling.rowCount > 0 && (
              <div className="mx-auto mt-4 h-2 w-64 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.min(100, (polling.appliedCount / polling.rowCount) * 100)}%` }}
                />
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
              <div className="w-full space-y-1 sm:w-80">
                <label className="text-xs text-muted-foreground">Select set</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search sets..."
                    value={setSearch}
                    onChange={(event) => setSetSearch(event.target.value)}
                    className="h-9 pl-8"
                  />
                </div>
              </div>
              {setsLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>

            {!selectedSet && !loading && (
              <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
                {[...groupedSets.entries()].map(([group, groupSets]) => (
                  <div key={group}>
                    <div className="sticky top-0 border-b border-border bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-muted-foreground backdrop-blur">
                      {group} ({groupSets.length})
                    </div>
                    {groupSets.map((set) => (
                      <button
                        key={set.set_code}
                        onClick={() => handleSetSelect(set.set_code)}
                        className="flex w-full items-center justify-between border-b border-border/50 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
                      >
                        <span>{set.set_name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{set.set_code.toUpperCase()}</span>
                      </button>
                    ))}
                  </div>
                ))}

                {filteredSets.length === 0 && !setsLoading && (
                  <p className="p-4 text-center text-sm text-muted-foreground">No sets found</p>
                )}
              </div>
            )}

            {selectedSet && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">{selectedSet.toUpperCase()}</Badge>
                <span className="text-sm text-muted-foreground">{sets.find((set) => set.set_code === selectedSet)?.set_name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => {
                    setSelectedSet("");
                    setRows([]);
                  }}
                >
                  Change set
                </Button>
              </div>
            )}

            {loading && (
              <div className="flex items-center justify-center gap-2 py-16">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Loading cards…</span>
              </div>
            )}

            {rows.length > 0 && !loading && (
              <>
                <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
                  <span><strong className="text-foreground">{rows.length}</strong> cards in set</span>
                  <span className="text-border">|</span>
                  <span><strong className="text-foreground">{activeRows.length}</strong> rows with qty &gt; 0</span>
                  <span className="text-border">|</span>
                  <span>Total: <strong className="text-primary">{totalCards}</strong> cards to import</span>
                </div>

                <div className="max-h-[55vh] overflow-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-secondary/50">
                        <TableHead className="w-10 text-xs"></TableHead>
                        <TableHead className="text-xs">Name</TableHead>
                        <TableHead className="w-10 text-xs">R</TableHead>
                        <TableHead className="w-[60px] text-right text-xs">#</TableHead>
                        <TableHead className="w-[70px] text-xs">Qty</TableHead>
                        <TableHead className="w-[60px] text-center text-xs">Stock</TableHead>
                        <TableHead className="w-[75px] text-xs">Cond</TableHead>
                        <TableHead className="w-14 text-xs">Foil</TableHead>
                        <TableHead className="w-20 text-right text-xs">Price</TableHead>
                        <TableHead className="w-24 text-right text-xs">Sold</TableHead>
                        <TableHead className="w-10 text-xs"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row, index) => {
                        const price = getPrice(row);
                        const isActive = row.quantity > 0;
                        const rarityBadge = RARITY_BADGE[row.rarity?.toLowerCase()] ?? RARITY_BADGE.common;

                        return (
                          <TableRow key={row._key} className={isActive ? "bg-blue-500/10" : "opacity-60"}>
                            <TableCell className="px-2">
                              {row.image_url_small ? (
                                <CardImageHover src={row.image_url_small} alt={row.name}>
                                  <img src={row.image_url_small} alt="" className="h-8 w-8 rounded object-cover cursor-pointer" />
                                </CardImageHover>
                              ) : (
                                <div className="h-8 w-8 rounded bg-muted" />
                              )}
                            </TableCell>
                            <TableCell className="max-w-[200px] text-xs">
                              <span className="block truncate font-medium">{row.name}</span>
                            </TableCell>
                            <TableCell className="px-1">
                              <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${rarityBadge.cls}`}>
                                {rarityBadge.letter}
                              </span>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">{row.collector_number}</TableCell>
                            <TableCell>
                              <Input
                                ref={(element) => {
                                  if (element) qtyRefs.current.set(row._key, element);
                                  else qtyRefs.current.delete(row._key);
                                }}
                                type="number"
                                min={0}
                                value={row.quantity || ""}
                                onChange={(event) => updateRow(row._key, { quantity: Math.max(0, parseInt(event.target.value) || 0) })}
                                onKeyDown={(event) => handleQtyKeyDown(event, index)}
                                className="h-7 w-[70px] text-center text-xs"
                                placeholder="0"
                              />
                            </TableCell>
                            <TableCell className="text-center">
                              {row.total_stock_all > 0 ? (
                                <span className="inline-flex min-w-[28px] items-center justify-center rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-foreground/70">
                                  <strong>{row.total_stock_all}</strong>
                                  <span className="ml-0.5 text-muted-foreground">({row.current_stock})</span>
                                </span>
                              ) : (
                                <span className="inline-flex min-w-[28px] items-center justify-center rounded bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/60">
                                  0
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Select value={row.condition} onValueChange={(value) => updateRow(row._key, { condition: value })}>
                                <SelectTrigger className="h-7 w-[75px] text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {CONDITION_OPTIONS.map((o) => (
                                    <SelectItem key={o.value} value={o.value} className="text-xs">
                                      {o.value}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Checkbox checked={row.foil} onCheckedChange={(value) => updateRow(row._key, { foil: !!value })} />
                                {row.foil && <Sparkles className="h-3 w-3 text-amber-400" />}
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-xs font-medium">
                              {price !== null ? <span>{Math.round(price)} kr</span> : <span className="text-muted-foreground">–</span>}
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">{getSoldDisplay(row)}</TableCell>
                            <TableCell>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => duplicateRow(row._key)} title="Duplicate row">
                                <Plus className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                  <Button variant="secondary" onClick={handleModalClose}>Cancel</Button>
                  <Button onClick={handleConfirm} disabled={activeRows.length === 0} className="bg-green-600 text-white hover:bg-green-700">
                    Import {totalCards} cards
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
