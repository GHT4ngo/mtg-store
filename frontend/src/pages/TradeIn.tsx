import { useState, useCallback, useRef } from "react";
import { Upload, Loader2, AlertTriangle, Check, Copy, Pencil, X, Save, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import StoreHeader from "@/components/StoreHeader";
import CardImageHover from "@/components/CardImageHover";
import {
  uploadTradeInPreview,
  submitTradeIn,
  fetchCardOptions,
  type TradeInPreviewResponse,
  type TradeInRow,
  type CardSetOption,
  type CardPrintingOption,
} from "@/lib/tradeinApi";

type TradeType = "trade_cards" | "trade_products" | "cash";
type ViewState = "upload" | "preview" | "submitting" | "success";

import { CONDITION_OPTIONS, conditionLabel } from "@/lib/conditions";
const LANGUAGES = ["EN", "FR", "DE", "JA", "IT", "ES", "PT", "RU", "KO", "CS", "CT"] as const;

/** Normalise foil from API — handles both boolean and string */
function isFoil(val: unknown): boolean {
  if (typeof val === "string") return val === "foil";
  return !!val;
}

export default function TradeInPage() {
  const [view, setView] = useState<ViewState>("upload");
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<TradeInPreviewResponse | null>(null);
  const [tradeType, setTradeType] = useState<TradeType>("trade_cards");
  const [email, setEmail] = useState("");
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<TradeInRow>>({});
  const [editedRows, setEditedRows] = useState<Set<number>>(new Set());
  const [successData, setSuccessData] = useState<{ token: string; email: string; total: number; tradeType: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Set/printing picker state
  const [setOptions, setSetOptions] = useState<CardSetOption[]>([]);
  const [setOptionsLoading, setSetOptionsLoading] = useState(false);
  const [setPickerOpen, setSetPickerOpen] = useState(false);
  const [setSearch, setSetSearch] = useState("");
  const [printingOptions, setPrintingOptions] = useState<CardPrintingOption[]>([]);
  const [printingLoading, setPrintingLoading] = useState(false);
  const [printingPickerOpen, setPrintingPickerOpen] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.endsWith(".csv")) {
      toast.error("Only .csv files are accepted");
      return;
    }
    setUploading(true);
    try {
      const data = await uploadTradeInPreview(file);
      setPreview(data);
      setEditedRows(new Set());
      setView("preview");
    } catch {
      toast.error("Failed to process file");
    } finally {
      setUploading(false);
    }
  }, []);

  const recalcTotals = useCallback((rows: TradeInRow[]): TradeInPreviewResponse => {
    // Client-side recalculation of totals
    const totalCards = rows.reduce((s, r) => s + r.quantity, 0);
    const uniqueCards = rows.length;
    const totalBase = rows.reduce((s, r) => s + r.tradein_final_sek * r.quantity, 0);
    // Approximate the trade type multipliers based on existing ratios
    // Use the preview's existing ratio if available
    const p = preview!;
    const oldTotal = p.trade_cards_sek || 1;
    const cardsRatio = p.trade_cards_sek / oldTotal;
    const productsRatio = p.trade_products_sek / oldTotal;
    const cashRatio = p.trade_cash_sek / oldTotal;

    return {
      ...p,
      rows,
      total_cards: totalCards,
      unique_cards: uniqueCards,
      trade_cards_sek: Math.round(totalBase * cardsRatio),
      trade_products_sek: Math.round(totalBase * productsRatio),
      trade_cash_sek: Math.round(totalBase * cashRatio),
    };
  }, [preview]);

  const startEdit = (index: number) => {
    if (!preview) return;
    const row = preview.rows[index];
    setEditingRow(index);
    setEditDraft({
      quantity: row.quantity,
      condition: row.condition,
      language: row.language,
      foil: row.foil,
      set_code: row.set_code,
      set_name: row.set_name,
      collector_number: row.collector_number,
      scryfall_id: row.scryfall_id,
      image_url_small: row.image_url_small,
    });
    setSetOptions([]);
    setPrintingOptions([]);
    setSetPickerOpen(false);
    setPrintingPickerOpen(false);
  };

  const saveEdit = (index: number) => {
    if (!preview) return;
    const updatedRows = [...preview.rows];
    updatedRows[index] = { ...updatedRows[index], ...editDraft };
    setEditingRow(null);
    setEditDraft({});
    setEditedRows(prev => new Set(prev).add(index));
    setPreview(recalcTotals(updatedRows));
  };

  const cancelEdit = () => {
    setEditingRow(null);
    setEditDraft({});
    setSetPickerOpen(false);
    setPrintingPickerOpen(false);
  };

  const openSetPicker = async (cardName: string) => {
    setSetOptionsLoading(true);
    setSetPickerOpen(true);
    setSetSearch("");
    try {
      const opts = await fetchCardOptions(cardName) as CardSetOption[];
      // Sort newest first
      opts.sort((a, b) => b.released_at.localeCompare(a.released_at));
      setSetOptions(opts);
    } catch {
      toast.error("Failed to load set options");
      setSetPickerOpen(false);
    } finally {
      setSetOptionsLoading(false);
    }
  };

  const selectSet = async (opt: CardSetOption, cardName: string) => {
    setEditDraft(d => ({
      ...d,
      set_code: opt.set_code,
      set_name: opt.set_name,
      collector_number: "",
      scryfall_id: "",
    }));
    setSetPickerOpen(false);
    // Load printings for this set
    setPrintingLoading(true);
    setPrintingPickerOpen(true);
    try {
      const prints = await fetchCardOptions(cardName, opt.set_code) as CardPrintingOption[];
      setPrintingOptions(prints);
    } catch {
      toast.error("Failed to load printings");
      setPrintingPickerOpen(false);
    } finally {
      setPrintingLoading(false);
    }
  };

  const selectPrinting = (p: CardPrintingOption) => {
    setEditDraft(d => ({
      ...d,
      scryfall_id: p.scryfall_id,
      collector_number: p.collector_number,
      image_url_small: p.image_url_small,
    }));
    setPrintingPickerOpen(false);
    setPrintingOptions([]);
  };

  const openPrintingPicker = async (cardName: string, setCode: string) => {
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

  const tradeValue = preview
    ? tradeType === "trade_cards"
      ? preview.trade_cards_sek
      : tradeType === "trade_products"
      ? preview.trade_products_sek
      : preview.trade_cash_sek
    : 0;

  const handleSubmit = useCallback(async () => {
    if (!preview || !email.trim()) {
      toast.error("Please enter your email");
      return;
    }
    setView("submitting");
    try {
      const typeLabel = tradeType === "trade_cards" ? "MTG Cards" : tradeType === "trade_products" ? "Other Products" : "Cash";
      const result = await submitTradeIn(email.trim(), tradeType, preview.rows);
      setSuccessData({
        token: result.token,
        email: result.email,
        total: result.total_value_sek,
        tradeType: typeLabel,
      });
      setView("success");
    } catch {
      toast.error("Submission failed");
      setView("preview");
    }
  }, [preview, email, tradeType]);

  const copyToken = () => {
    if (successData) {
      navigator.clipboard.writeText(successData.token);
      toast.success("Token copied!");
    }
  };

  const activeRowCount = preview?.rows.filter(r => r.tradein_final_sek > 0).length ?? 0;

  const filteredSetOptions = setSearch
    ? setOptions.filter(o =>
        o.set_name.toLowerCase().includes(setSearch.toLowerCase()) ||
        o.set_code.toLowerCase().includes(setSearch.toLowerCase())
      )
    : setOptions;

  return (
    <div className="min-h-screen bg-background">
      <StoreHeader />
      <main className="container max-w-6xl space-y-6 py-6">
        {view === "upload" && (
          <>
            <h2 className="text-2xl font-display font-bold text-foreground">Trade In Your Cards</h2>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              <div className="flex gap-2">
                <div className="text-sm text-foreground/80">
                  <p className="font-medium text-foreground">Important Information</p>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    <li>We rarely accept common and uncommons with some exceptions</li>
                    <li>Please keep your list under 200 cards to make it easier for all parties</li>
                    <li>Cards must be sorted in the same way as the list below</li>
                    <li>Double check that the condition, set, collector number, quantity and if it's foil is correct</li>
                  </ul>
                </div>
              </div>
            </div>

            <div
              onClick={() => !uploading && fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border py-16 transition-colors hover:border-primary/50"
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) handleFile(e.target.files[0]);
                }}
              />
              {uploading ? (
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
              ) : (
                <>
                  <Upload className="mb-3 h-10 w-10 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Upload your Manabox collection export</p>
                  <p className="mt-1 text-xs text-muted-foreground">Only .csv files</p>
                </>
              )}
            </div>
          </>
        )}

        {view === "preview" && preview && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-display font-bold text-foreground">Trade-In Preview</h2>
              <Button variant="ghost" size="sm" onClick={() => { setView("upload"); setPreview(null); }}>
                ← Start over
              </Button>
            </div>

            {/* Summary bar */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span><span className="font-medium text-foreground">{preview.total_cards}</span> cards ({preview.unique_cards} unique)</span>
              <span>·</span>
              <span><span className="font-medium text-foreground">{activeRowCount}</span> with trade value</span>
            </div>

            {/* Missing price warning */}
            {preview.missing_price.length > 0 && (
              <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3">
                <p className="text-sm text-orange-400">
                  ⚠️ {preview.missing_price.length} cards have no price data:{" "}
                  <span className="text-orange-300">
                    {preview.missing_price.map(c => c.name).join(", ")}
                  </span>
                </p>
              </div>
            )}

            {/* Trade option buttons */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TradeOptionButton
                active={tradeType === "trade_cards"}
                onClick={() => setTradeType("trade_cards")}
                label="Trade for MTG Cards"
                value={preview.trade_cards_sek}
              />
              <TradeOptionButton
                active={tradeType === "trade_products"}
                onClick={() => setTradeType("trade_products")}
                label="Trade for Other Products"
                value={preview.trade_products_sek}
              />
              <TradeOptionButton
                active={tradeType === "cash"}
                onClick={() => setTradeType("cash")}
                label="Cash"
                value={preview.trade_cash_sek}
              />
            </div>

            {/* Table */}
            <div className="max-h-[55vh] overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/50">
                    <TableHead className="w-[40px] text-xs">Set</TableHead>
                    <TableHead className="w-[50px] text-xs text-right">#</TableHead>
                    <TableHead className="text-xs">Card Name</TableHead>
                    <TableHead className="w-[50px] text-xs text-center">Foil</TableHead>
                    <TableHead className="w-[70px] text-xs">Cond</TableHead>
                    <TableHead className="w-[50px] text-xs">Lang</TableHead>
                    <TableHead className="w-[50px] text-xs text-right">Qty</TableHead>
                    <TableHead className="w-[70px] text-xs text-right">Trend (€)</TableHead>
                    <TableHead className="w-[90px] text-xs text-right">Trade Value</TableHead>
                    <TableHead className="w-[120px] text-xs">Notes</TableHead>
                    <TableHead className="w-[60px] text-xs"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row, i) => {
                    const isZero = row.tradein_final_sek === 0;
                    const isMissing = preview.missing_price.some(
                      m => m.name === row.name && m.set_code === row.set_code
                    );
                    const isEditing = editingRow === i;
                    const isEdited = editedRows.has(i);

                    return (
                      <TableRow
                        key={`${row.scryfall_id}-${i}`}
                        className={
                          isMissing
                            ? "bg-orange-500/5"
                            : isZero
                            ? "opacity-50"
                            : ""
                        }
                      >
                        <TableCell className="text-xs font-mono text-muted-foreground uppercase">
                          {isEditing ? (
                            <Popover open={setPickerOpen} onOpenChange={setSetPickerOpen}>
                              <PopoverTrigger asChild>
                                <button
                                  className="cursor-pointer text-primary text-xs font-mono uppercase hover:underline"
                                  onClick={() => openSetPicker(row.name)}
                                >
                                  {editDraft.set_code || row.set_code}
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
                                          opt.set_code === (editDraft.set_code || row.set_code)
                                            ? "bg-primary/10 font-medium text-primary"
                                            : "text-foreground"
                                        }`}
                                        onClick={() => selectSet(opt, row.name)}
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
                        <TableCell className="text-xs font-mono text-right text-muted-foreground">
                          {isEditing ? (
                            <Popover open={printingPickerOpen} onOpenChange={setPrintingPickerOpen}>
                              <PopoverTrigger asChild>
                                <button
                                  className="cursor-pointer text-primary text-xs font-mono hover:underline"
                                  onClick={() => openPrintingPicker(row.name, editDraft.set_code || row.set_code)}
                                >
                                  {editDraft.collector_number || "—"}
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
                                          p.scryfall_id === (editDraft.scryfall_id || row.scryfall_id)
                                            ? "ring-2 ring-primary bg-primary/10"
                                            : ""
                                        }`}
                                        onClick={() => selectPrinting(p)}
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
                        <TableCell className="text-xs max-w-[200px]">
                          <div className="flex items-center gap-2">
                            {isEdited && (
                              <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-primary" title="Edited" />
                            )}
                            {row.image_url_small && (
                              <CardImageHover src={row.image_url_small} alt={row.name}>
                                <img
                                  src={row.image_url_small}
                                  alt=""
                                  className="h-8 w-6 rounded-sm object-cover flex-shrink-0"
                                />
                              </CardImageHover>
                            )}
                            <span className={`truncate ${isZero ? "line-through" : ""}`}>
                              {row.name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-center text-xs">
                          {isEditing ? (
                            <Checkbox
                              checked={isFoil(editDraft.foil)}
                              onCheckedChange={(v) => setEditDraft({ ...editDraft, foil: v ? "foil" : "normal" })}
                            />
                          ) : (
                            isFoil(row.foil) ? <span>✨</span> : null
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {isEditing ? (
                            <Select
                              value={editDraft.condition ?? "NM"}
                              onValueChange={(v) => setEditDraft({ ...editDraft, condition: v })}
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
                        <TableCell className="text-xs">
                          {isEditing ? (
                            <Select
                              value={editDraft.language ?? "EN"}
                              onValueChange={(v) => setEditDraft({ ...editDraft, language: v })}
                            >
                              <SelectTrigger className="h-7 w-[60px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {LANGUAGES.map(l => (
                                  <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-muted-foreground">{row.language}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {isEditing ? (
                            <Input
                              type="number"
                              min={1}
                              value={editDraft.quantity ?? 1}
                              onChange={(e) => setEditDraft({ ...editDraft, quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                              className="h-7 w-[55px] text-xs text-right"
                            />
                          ) : (
                            row.quantity
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-right text-muted-foreground">
                          {row.price_trend_eur != null ? `€${row.price_trend_eur.toFixed(2)}` : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          <span className={isZero ? "line-through text-muted-foreground" : "font-medium text-foreground"}>
                            {row.tradein_final_sek > 0 ? `${row.tradein_final_sek} kr` : "0 kr"}
                          </span>
                        </TableCell>
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
                        <TableCell>
                          {isEditing ? (
                            <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => saveEdit(i)}>
                                <Save className="h-3 w-3" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={cancelEdit}>
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEdit(i)}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Submit section */}
            <div className="rounded-lg border border-border bg-card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-lg font-bold text-foreground">{tradeValue} kr</p>
                  <p className="text-xs text-muted-foreground">
                    {tradeType === "trade_cards" ? "Trade for MTG Cards" : tradeType === "trade_products" ? "Trade for Other Products" : "Cash"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="email"
                  placeholder="Your email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="max-w-xs"
                />
                <Button
                  onClick={handleSubmit}
                  disabled={!email.trim() || activeRowCount === 0}
                  className="bg-green-600 text-white hover:bg-green-700"
                >
                  Submit Trade-In
                </Button>
              </div>
            </div>
          </div>
        )}

        {view === "submitting" && (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">Submitting your trade-in...</p>
          </div>
        )}

        {view === "success" && successData && (
          <div className="space-y-6">
            <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-8 text-center space-y-4">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20">
                <Check className="h-8 w-8 text-green-500" />
              </div>
              <h2 className="text-xl font-display font-bold text-foreground">Trade-in submitted!</h2>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Your token:</p>
                <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2">
                  <code className="text-lg font-bold font-mono text-primary">{successData.token}</code>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyToken}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Show this token and your email <span className="font-medium text-foreground">{successData.email}</span> at the store.
                </p>
                <p className="text-lg font-bold text-foreground">
                  Total value: {successData.total} kr ({successData.tradeType})
                </p>
              </div>
            </div>
            <Button variant="secondary" onClick={() => { setView("upload"); setPreview(null); setSuccessData(null); setEmail(""); }}>
              ← Start New Trade-In
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}

function TradeOptionButton({
  active,
  onClick,
  label,
  value,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  value: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-colors ${
        active
          ? "border-primary bg-primary/10"
          : "border-border bg-card hover:border-primary/30"
      }`}
    >
      <span className="text-sm font-medium text-foreground">{label}</span>
      <p className={`mt-1 text-lg font-bold ${active ? "text-primary" : "text-foreground"}`}>
        {value} kr
      </p>
    </button>
  );
}
