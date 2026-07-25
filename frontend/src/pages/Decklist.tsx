import { useState, useRef, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  searchDecklist, formatPrice, getDiscountedPrice,
  type DecklistCardResult, type DecklistResponse, type Card,
} from "@/lib/api";
import { CartProvider, useCart } from "@/components/CartContext";
import CartDrawer from "@/components/CartDrawer";
import StoreHeader from "@/components/StoreHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card as UICard, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Loader2, Upload, CheckCircle2, XCircle, AlertCircle,
  ChevronDown, ChevronUp, ShoppingCart, Minus, Plus,
} from "lucide-react";

// ─── Selection model ──────────────────────────────────────────────────────────
//
// Each card can have multiple variants selected simultaneously.
// CardSelections = { [variantKey]: qty }  — qty=0 means not selected
// SelectionMap   = { [requested_name]: CardSelections }

type CardSelections = Record<string, number>;
type SelectionMap   = Record<string, CardSelections>;

function variantKey(v: Card): string {
  return `${v.scryfall_id}__${v.condition ?? "NM"}__${v.is_foil}`;
}

const COND_ORDER = ["MT", "NM", "VF", "FN", "GD", "FR", "PR"];

function pickBestVariant(variants: Card[], requestedQty: number): Card | null {
  let candidates = variants.filter(v => v.in_stock && v.total_stock > 0 && !v.is_foil);
  if (candidates.length === 0)
    candidates = variants.filter(v => v.in_stock && v.total_stock > 0);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const pa = (a.is_foil ? a.sell_price_foil_sek : a.sell_price_sek) ?? Infinity;
    const pb = (b.is_foil ? b.sell_price_foil_sek : b.sell_price_sek) ?? Infinity;
    if (pa !== pb) return pa - pb;
    const ca = COND_ORDER.indexOf(a.condition ?? "NM");
    const cb = COND_ORDER.indexOf(b.condition ?? "NM");
    if (ca !== cb) return ca - cb;
    const aFill = a.total_stock >= requestedQty ? 0 : 1;
    const bFill = b.total_stock >= requestedQty ? 0 : 1;
    if (aFill !== bFill) return aFill - bFill;
    return b.total_stock - a.total_stock;
  })[0];
}

function initSelections(result: DecklistResponse): SelectionMap {
  const map: SelectionMap = {};
  for (const entry of [...result.main, ...result.sideboard]) {
    const best = pickBestVariant(entry.variants, entry.requested_qty);
    if (best) {
      const qty = Math.min(entry.requested_qty, best.stock_a ?? best.total_stock ?? 1);
      map[entry.requested_name] = { [variantKey(best)]: qty };
    } else {
      map[entry.requested_name] = {};
    }
  }
  return map;
}

/** Total qty selected across all variants for one card */
function totalSelected(cardSels: CardSelections): number {
  return Object.values(cardSels).reduce((s, q) => s + q, 0);
}

// ─── Summary bar ──────────────────────────────────────────────────────────────

function SummaryBar({ main, side, selections, allEntries, onAddAll }: {
  main: DecklistResponse["summary_main"];
  side: DecklistResponse["summary_side"];
  selections: SelectionMap;
  allEntries: DecklistCardResult[];
  onAddAll: () => void;
}) {
  const { totalItems } = useCart();
  const totalCards  = main.total_cards + side.total_cards;
  const filledCards = main.filled_cards + side.filled_cards;
  const pct = totalCards > 0 ? Math.round((filledCards / totalCards) * 100) : 0;

  let selectedCost = 0;
  let selectedQtyTotal = 0;
  for (const entry of allEntries) {
    const cardSels = selections[entry.requested_name] ?? {};
    for (const [vk, qty] of Object.entries(cardSels)) {
      if (qty <= 0) continue;
      const v = entry.variants.find(x => variantKey(x) === vk);
      if (!v) continue;
      const price = v.is_foil ? v.sell_price_foil_sek : v.sell_price_sek;
      selectedCost += (price ?? 0) * qty;
      selectedQtyTotal += qty;
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap gap-6 items-center justify-between">
        <div className="flex flex-wrap gap-6 items-center">
          <div className="text-center">
            <div className="text-2xl font-bold text-primary">
              {filledCards}<span className="text-muted-foreground text-base font-normal">/{totalCards}</span>
            </div>
            <div className="text-xs text-muted-foreground">cards available</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold">{formatPrice(Math.round(selectedCost))}</div>
            <div className="text-xs text-muted-foreground">selected build cost</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-destructive">{main.missing_cards + side.missing_cards}</div>
            <div className="text-xs text-muted-foreground">missing copies</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-muted-foreground">{main.names_missing + side.names_missing}</div>
            <div className="text-xs text-muted-foreground">cards not stocked</div>
          </div>
        </div>
        <Button onClick={onAddAll} disabled={selectedQtyTotal === 0} className="shrink-0">
          <ShoppingCart className="h-4 w-4 mr-2" />
          Add {selectedQtyTotal} to cart{totalItems > 0 ? ` (${totalItems} in cart)` : ""}
        </Button>
      </div>
      <div>
        <div className="flex justify-between text-xs text-muted-foreground mb-1">
          <span>Stock coverage</span><span>{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

// ─── Single variant row ───────────────────────────────────────────────────────

function VariantRow({ variant, qty, requestedQty, onSelect, onQtyChange }: {
  variant: Card;
  qty: number;        // 0 = not selected
  requestedQty: number;
  onSelect: () => void;
  onQtyChange: (newQty: number) => void;
}) {
  const isSelected = qty > 0;
  const price = getDiscountedPrice(variant);
  const foilLabel = variant.special_foil_type ?? (variant.is_foil ? "Foil" : null);
  const specialLabel =
    variant.special_print === "THE_LIST"          ? "The List" :
    variant.special_print === "MYSTERY_BOOSTER"   ? "Mystery Booster" :
    variant.special_print === "MYSTERY_BOOSTER_2" ? "Mystery Booster 2" : null;
  const maxQty = variant.stock_a ?? variant.total_stock ?? 0;
  const outOfStock = !variant.in_stock || variant.total_stock === 0;

  return (
    <div
      className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded transition-colors flex-wrap
        ${isSelected
          ? "bg-green-950/50 border border-green-700/60"
          : outOfStock
          ? "opacity-40 border border-transparent"
          : "hover:bg-secondary/50 border border-transparent cursor-pointer"
        }`}
      onClick={!isSelected && !outOfStock ? onSelect : undefined}
    >
      <img src={variant.image_url_small} alt={variant.name} className="w-7 rounded shrink-0" />
      <span className={isSelected ? "text-green-300" : "text-muted-foreground"}>
        {variant.set_name} #{variant.collector_number}
      </span>
      <span className={isSelected ? "text-green-300" : "text-muted-foreground"}>
        {variant.condition ?? "NM"}
      </span>
      {foilLabel   && <span className="text-orange-400">{foilLabel}</span>}
      {specialLabel && <span className="text-teal-400">{specialLabel}</span>}
      <span className={isSelected ? "text-green-300" : "text-muted-foreground"}>
        ×{variant.total_stock} in stock
      </span>
      <span className={`font-medium ${isSelected ? "text-green-200" : ""}`}>{formatPrice(price)}</span>
      {variant.language && variant.language !== "English" && (
        <Badge variant="outline" className="text-[10px] py-0">{variant.language}</Badge>
      )}

      <div className="ml-auto flex items-center gap-2" onClick={e => e.stopPropagation()}>
        {isSelected ? (
          <div className="flex items-center gap-1">
            {/* - button: goes to 0 which deselects */}
            <button
              className="w-5 h-5 rounded border border-green-700 flex items-center justify-center hover:bg-green-800/50 disabled:opacity-30 transition-colors"
              onClick={() => onQtyChange(qty - 1)}
            >
              <Minus className="h-3 w-3 text-green-300" />
            </button>
            <span className="w-6 text-center font-bold text-green-300">{qty}</span>
            <button
              className="w-5 h-5 rounded border border-green-700 flex items-center justify-center hover:bg-green-800/50 disabled:opacity-30 transition-colors"
              onClick={() => onQtyChange(qty + 1)}
              disabled={qty >= maxQty}
            >
              <Plus className="h-3 w-3 text-green-300" />
            </button>
          </div>
        ) : !outOfStock ? (
          <button
            className="text-[10px] border border-border rounded px-1.5 py-0.5 hover:bg-primary/10 hover:border-primary/40 transition-colors"
            onClick={e => { e.stopPropagation(); onSelect(); }}
          >
            Select
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Card result row ──────────────────────────────────────────────────────────

function CardResultRow({ entry, cardSels, onToggle, onQtyChange }: {
  entry: DecklistCardResult;
  cardSels: CardSelections;
  /** Toggle a variant: if unselected, add 1 (stealing from the highest-qty existing selection if at cap) */
  onToggle: (vk: string) => void;
  /** Set qty for a specific variant (0 = deselect) */
  onQtyChange: (vk: string, qty: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const { requested_name, requested_qty, total_available, can_fill, variants } = entry;

  const hasAny  = variants.length > 0;
  const partial = hasAny && !can_fill && total_available > 0;

  // Compute selected total cost
  let selectedTotal = 0;
  let selectedQtySum = 0;
  for (const [vk, qty] of Object.entries(cardSels)) {
    if (qty <= 0) continue;
    const v = variants.find(x => variantKey(x) === vk);
    if (!v) continue;
    const price = v.is_foil ? v.sell_price_foil_sek : v.sell_price_sek;
    selectedTotal += (price ?? 0) * qty;
    selectedQtySum += qty;
  }

  const statusIcon = !hasAny
    ? <XCircle className="h-4 w-4 text-destructive shrink-0" />
    : partial
    ? <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />
    : can_fill
    ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
    : <XCircle className="h-4 w-4 text-destructive shrink-0" />;

  const inStockVariants    = variants.filter(v => v.in_stock && v.total_stock > 0);
  const outOfStockVariants = variants.filter(v => !v.in_stock || v.total_stock === 0);

  // Show qty fraction in header if multiple variants selected
  const selectionLabel = selectedQtySum > 0
    ? `${selectedQtySum}/${requested_qty}`
    : `${total_available}/${requested_qty}`;

  return (
    <div className={`border-b border-border last:border-0 ${!hasAny ? "opacity-60" : ""}`}>
      <button
        className="w-full flex items-center gap-3 py-2 px-1 text-left hover:bg-secondary/30 transition-colors"
        onClick={() => hasAny && setOpen(o => !o)}
        disabled={!hasAny}
      >
        {statusIcon}
        <span className="text-sm font-medium w-6 text-right shrink-0">{requested_qty}×</span>
        <span className="flex-1 text-sm">{requested_name}</span>
        <span className={`text-xs shrink-0 ${
          total_available >= requested_qty ? "text-green-500"
          : total_available > 0           ? "text-yellow-500"
          : "text-muted-foreground"
        }`}>
          {selectionLabel}
        </span>
        <span className="text-sm font-medium w-20 text-right shrink-0">
          {selectedTotal > 0
            ? <span className="text-green-400">{formatPrice(Math.round(selectedTotal))}</span>
            : entry.cheapest_total ? formatPrice(entry.cheapest_total) : "–"
          }
        </span>
        {selectedTotal > 0 && selectedQtySum > 0 ? (
          <span className="text-xs text-green-400 w-16 text-right shrink-0">
            {formatPrice(Math.round(selectedTotal / selectedQtySum))} ea.
          </span>
        ) : entry.cheapest_price ? (
          <span className="text-xs text-muted-foreground w-16 text-right shrink-0">
            {formatPrice(entry.cheapest_price)} ea.
          </span>
        ) : <span className="w-16" />}
        {hasAny && (open
          ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
          : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="pl-3 pr-3 pb-2 space-y-1">
          {inStockVariants.length === 0 && (
            <p className="text-xs text-muted-foreground italic px-2">No copies in stock</p>
          )}
          {inStockVariants.map((v, i) => (
            <VariantRow
              key={i}
              variant={v}
              qty={cardSels[variantKey(v)] ?? 0}
              requestedQty={requested_qty}
              onSelect={() => onToggle(variantKey(v))}
              onQtyChange={qty => onQtyChange(variantKey(v), qty)}
            />
          ))}
          {outOfStockVariants.length > 0 && (
            <details className="mt-1">
              <summary className="text-[11px] text-muted-foreground cursor-pointer py-1">
                +{outOfStockVariants.length} out-of-stock printings
              </summary>
              <div className="mt-1 space-y-1">
                {outOfStockVariants.map((v, i) => (
                  <VariantRow
                    key={i}
                    variant={v}
                    qty={0}
                    requestedQty={requested_qty}
                    onSelect={() => {}}
                    onQtyChange={() => {}}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Deck section ─────────────────────────────────────────────────────────────

function DeckSection({ title, entries, selections, onToggle, onQtyChange }: {
  title: string;
  entries: DecklistCardResult[];
  selections: SelectionMap;
  onToggle: (name: string, vk: string) => void;
  onQtyChange: (name: string, vk: string, qty: number) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <UICard>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-1 px-1">
          <span className="w-4" />
          <span className="w-6 text-right">Qty</span>
          <span className="flex-1">Card</span>
          <span className="w-12 text-right">Selected</span>
          <span className="w-20 text-right">Total</span>
          <span className="w-16 text-right">Avg ea.</span>
          <span className="w-4" />
        </div>
        {entries.map((e, i) => (
          <CardResultRow
            key={i}
            entry={e}
            cardSels={selections[e.requested_name] ?? {}}
            onToggle={vk => onToggle(e.requested_name, vk)}
            onQtyChange={(vk, qty) => onQtyChange(e.requested_name, vk, qty)}
          />
        ))}
      </CardContent>
    </UICard>
  );
}

// ─── Results view ─────────────────────────────────────────────────────────────

function DecklistResults({ result, onReset }: { result: DecklistResponse; onReset: () => void }) {
  const cart = useCart();
  const [cartOpen, setCartOpen] = useState(false);
  const allEntries = [...result.main, ...result.sideboard];
  const [selections, setSelections] = useState<SelectionMap>(() => initSelections(result));

  /** Toggle a variant for a card.
   *  - If not selected: add with qty=1; if total would exceed requested_qty,
   *    steal 1 from the existing variant with the highest qty first.
   *  - If already selected: deselect (set to 0 / remove).
   */
  const handleToggle = useCallback((name: string, vk: string) => {
    setSelections(prev => {
      const entry = allEntries.find(e => e.requested_name === name);
      const cardSels = { ...(prev[name] ?? {}) };
      const currentQty = cardSels[vk] ?? 0;

      if (currentQty > 0) {
        // Deselect: remove this variant
        const next = { ...cardSels };
        delete next[vk];
        return { ...prev, [name]: next };
      }

      // Select: add with qty=1
      const maxStock = entry?.variants.find(v => variantKey(v) === vk);
      const maxQty   = maxStock ? (maxStock.stock_a ?? maxStock.total_stock ?? 1) : 1;
      const requestedQty = entry?.requested_qty ?? 1;
      const current  = totalSelected(cardSels);

      const next = { ...cardSels, [vk]: 1 };

      // If we're at or over the requested qty, steal 1 from the variant with highest qty
      if (current >= requestedQty) {
        const entries = Object.entries(next).filter(([k]) => k !== vk);
        if (entries.length > 0) {
          entries.sort((a, b) => b[1] - a[1]);
          const [stealKey, stealQty] = entries[0];
          if (stealQty <= 1) {
            delete next[stealKey];
          } else {
            next[stealKey] = stealQty - 1;
          }
        }
      }

      // Cap new variant at its stock
      next[vk] = Math.min(next[vk], maxQty);

      return { ...prev, [name]: next };
    });
  }, [allEntries]);

  const handleQtyChange = useCallback((name: string, vk: string, qty: number) => {
    setSelections(prev => {
      const cardSels = { ...(prev[name] ?? {}) };
      if (qty <= 0) {
        delete cardSels[vk];
      } else {
        cardSels[vk] = qty;
      }
      return { ...prev, [name]: cardSels };
    });
  }, []);

  const handleAddAll = useCallback(() => {
    let added = 0;
    let skipped = 0;
    for (const entry of allEntries) {
      const cardSels = selections[entry.requested_name] ?? {};
      for (const [vk, qty] of Object.entries(cardSels)) {
        if (qty <= 0) continue;
        const v = entry.variants.find(x => variantKey(x) === vk);
        if (!v) continue;
        const price = v.is_foil ? v.sell_price_foil_sek : v.sell_price_sek;
        if (!price || price <= 0) continue;
        const maxStock = v.stock_a ?? v.total_stock ?? 0;
        for (let i = 0; i < qty; i++) {
          const ok = cart.addItem({
            scryfall_id: v.scryfall_id,
            name: v.name,
            set_name: v.set_name,
            collector_number: v.collector_number,
            condition: v.condition ?? "NM",
            is_foil: v.is_foil,
            sell_price_sek: price,
          }, maxStock);
          if (!ok) { skipped++; break; }
          else added++;
        }
      }
    }
    if (added > 0) {
      toast.success(`Added ${added} card${added !== 1 ? "s" : ""} to cart`);
      setCartOpen(true);
    }
    if (skipped > 0)
      toast.error(`${skipped} card${skipped !== 1 ? "s" : ""} skipped (max stock reached)`);
  }, [allEntries, selections, cart]);

  return (
    <>
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
      <div className="space-y-4 max-w-3xl mx-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{result.deck_name || "Decklist"}</h2>
          <Button variant="outline" size="sm" onClick={onReset}>← New decklist</Button>
        </div>
        <SummaryBar
          main={result.summary_main}
          side={result.summary_side}
          selections={selections}
          allEntries={allEntries}
          onAddAll={handleAddAll}
        />
        <DeckSection
          title={`Main Deck (${result.summary_main.total_cards} cards)`}
          entries={result.main}
          selections={selections}
          onToggle={handleToggle}
          onQtyChange={handleQtyChange}
        />
        <DeckSection
          title={`Sideboard (${result.summary_side.total_cards} cards)`}
          entries={result.sideboard}
          selections={selections}
          onToggle={handleToggle}
          onQtyChange={handleQtyChange}
        />
      </div>
    </>
  );
}

// ─── Input step ───────────────────────────────────────────────────────────────

function DecklistInput({ onResult }: { onResult: (r: DecklistResponse) => void }) {
  const [text, setText] = useState("");
  const [deckName, setDeckName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: () => searchDecklist(text, deckName),
    onSuccess: onResult,
  });

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const base = file.name.replace(/\.txt$/i, "").replace(/^Deck\s*-\s*/i, "").trim();
    if (!deckName) setDeckName(base);
    file.text().then(setText);
  };

  return (
    <UICard className="max-w-2xl mx-auto">
      <CardHeader><CardTitle>Check Decklist</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-3">
          <Input
            placeholder="Deck name (optional)"
            value={deckName}
            onChange={e => setDeckName(e.target.value)}
            className="flex-1"
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4 mr-1" /> Upload .txt
          </Button>
          <input ref={fileRef} type="file" accept=".txt" className="hidden" onChange={handleFile} />
        </div>
        <Textarea
          placeholder={"Paste your decklist here, e.g.:\n4 Lightning Bolt\n4 Counterspell\n...\n\n1 Negate\n1 Spell Pierce"}
          value={text}
          onChange={e => setText(e.target.value)}
          rows={14}
          className="font-mono text-sm resize-none"
        />
        {mutation.isError && (
          <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
        )}
        <Button
          className="w-full"
          disabled={!text.trim() || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending
            ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Checking stock…</>
            : "Check Stock"
          }
        </Button>
      </CardContent>
    </UICard>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function DecklistContent() {
  const [result, setResult] = useState<DecklistResponse | null>(null);
  return (
    <div className="min-h-screen bg-background">
      <StoreHeader />
      <main className="container py-6">
        {result
          ? <DecklistResults result={result} onReset={() => setResult(null)} />
          : <DecklistInput onResult={setResult} />
        }
      </main>
    </div>
  );
}

export default function Decklist() {
  return (
    <CartProvider>
      <DecklistContent />
    </CartProvider>
  );
}
