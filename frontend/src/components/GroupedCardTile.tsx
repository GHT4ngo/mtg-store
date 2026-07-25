import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Card, CardGroup } from "@/lib/api";
import { getDiscountedPrice, formatPrice, isNonEnglish, getBackFaceUrl } from "@/lib/api";
import { ChevronDown, Sparkles, Layers, AlertTriangle, Globe, RotateCw } from "lucide-react";
import { getConditionSort } from "@/lib/conditions";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useCart } from "@/components/CartContext";
import { toast } from "sonner";

interface GroupedCardTileProps {
  group: CardGroup;
  onImageClick: (card: Card) => void;
}

function getRarityClass(rarity: string) {
  switch (rarity?.toLowerCase()) {
    case "uncommon": return "text-rarity-uncommon";
    case "rare": return "text-rarity-rare";
    case "mythic": return "text-rarity-mythic";
    default: return "text-rarity-common";
  }
}

function formatPriceRange(range: { min: number | null; max: number | null }): string {
  if (range.min === null) return "–";
  if (range.min === range.max || range.max === null) return `${Math.round(range.min)} kr`;
  return `${Math.round(range.min)} – ${Math.round(range.max)} kr`;
}

function getSpecialPrintBanner(special_print: string | null): { text: string; bg: string } | null {
  switch (special_print) {
    case "MYSTERY_BOOSTER": return { text: "Mystery Booster", bg: "bg-purple-600/80" };
    case "MYSTERY_BOOSTER_2": return { text: "Mystery Booster 2", bg: "bg-purple-600/80" };
    case "THE_LIST": return { text: "The List", bg: "bg-teal-600/80" };
    default: return null;
  }
}


/** Group an array of cards (printings within a name-group) by scryfall_id */
function subGroupByPrinting(printings: Card[]): Card[][] {
  const map = new Map<string, Card[]>();
  for (const card of printings) {
    const key = card.scryfall_id || `${card.name}|${card.set_code}|${card.collector_number}`;
    const arr = map.get(key) || [];
    arr.push(card);
    map.set(key, arr);
  }
  // Sort variants within each sub-group: non-foil before foil, then by condition order
  for (const variants of map.values()) {
    variants.sort((a, b) => {
      if (a.is_foil !== b.is_foil) return a.is_foil ? 1 : -1;
      return getConditionSort(a.condition) - getConditionSort(b.condition);
    });
  }
  // Sort sub-groups: in-stock first, then by set name
  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    const aInStock = a.some((c) => c.in_stock);
    const bInStock = b.some((c) => c.in_stock);
    if (aInStock !== bInStock) return aInStock ? -1 : 1;
    return b[0].set_name.localeCompare(a[0].set_name);
  });
  return groups;
}

export default function GroupedCardTile({ group, onImageClick }: GroupedCardTileProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden card-glow">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-secondary/50 transition-colors"
      >
        <img
          src={group.image_url_small}
          alt={group.name}
          className="w-12 h-16 object-cover rounded flex-shrink-0"
          loading="lazy"
        />
        <div className="flex-1 min-w-0 space-y-0.5">
          <p className="font-display font-semibold text-sm text-foreground truncate">{group.name}</p>
          <p className="text-[11px] text-muted-foreground truncate">{group.type_line}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-primary">
              {formatPriceRange(group.priceRange)}
            </span>
            {group.hasFoil && group.foilPriceRange.min !== null && (
              <span className="text-sm font-semibold flex items-center gap-0.5 text-orange-400">
                <Sparkles className="h-3 w-3" />
                {formatPriceRange(group.foilPriceRange)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {group.totalStock > 0 ? (
            <Badge variant="outline" className="text-primary border-primary/40 text-[10px]">
              {group.totalStock} st
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[10px]">Slut</Badge>
          )}
          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
            <Layers className="h-3 w-3" /> {group.versionCount} ver.
          </span>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <ExpandedPrintings printings={group.printings} onImageClick={onImageClick} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ExpandedPrintings({ printings, onImageClick }: { printings: Card[]; onImageClick: (card: Card) => void }) {
  const subGroups = useMemo(() => subGroupByPrinting(printings), [printings]);

  return (
    <div className="border-t border-border divide-y divide-border">
      {subGroups.map((variants) => (
        <PrintingRow key={variants[0].scryfall_id || `${variants[0].set_code}-${variants[0].collector_number}`} variants={variants} onImageClick={onImageClick} />
      ))}
    </div>
  );
}

function PrintingRow({ variants, onImageClick }: { variants: Card[]; onImageClick: (card: Card) => void }) {
  const cart = useCart();
  const card = variants[0]; // representative card for shared fields
  const allOutOfStock = variants.every((v) => !v.in_stock || v.total_stock === 0);
  const nonEnglish = isNonEnglish(card);
  const backUrl = getBackFaceUrl(card);
  const [showBack, setShowBack] = useState(false);
  const [backExists, setBackExists] = useState(true);
  const banner = getSpecialPrintBanner(card.special_print);
  const currentImageUrl = (backUrl && showBack && backExists) ? backUrl : card.image_url_normal;

  // Data quality warning
  const showWarning = card.data_quality === "NAME_MATCH_ASSUMED" || card.data_quality === "NAME_MATCH_PROMO";
  const warningTooltip = card.data_quality === "NAME_MATCH_ASSUMED"
    ? "Set or collector number may be approximate"
    : "Promo card — price is from this set's listing";

  // Build in-stock variant buttons
  const inStockVariants = variants.filter((v) => v.in_stock && v.total_stock > 0);

  const handleAdd = (variant: Card) => {
    const price = variant.is_foil ? variant.sell_price_foil_sek : variant.sell_price_sek;
    if (!price || price <= 0) return;
    const stock = variant.stock_a ?? variant.total_stock ?? 0;
    const added = cart.addItem({
      scryfall_id: variant.scryfall_id,
      name: variant.name,
      set_name: variant.set_name,
      collector_number: variant.collector_number,
      condition: variant.condition ?? "NM",
      is_foil: variant.is_foil,
      sell_price_sek: price,
    }, stock);
    if (added) {
      toast.success(`${variant.name} (${variant.condition ?? "NM"}${variant.is_foil ? " ✨" : ""}) added to cart`);
    } else {
      toast.error(`Max stock reached for ${variant.name} (${variant.condition ?? "NM"}${variant.is_foil ? " ✨" : ""})`);
    }
  };

  return (
    <div className={`flex gap-3 p-3 ${allOutOfStock ? "opacity-50" : ""}`}>
      <div className="flex-shrink-0 relative">
        <img
          src={currentImageUrl}
          alt={card.name}
          className="w-20 md:w-24 rounded cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
          loading="lazy"
          onClick={() => onImageClick(card)}
          onError={() => { if (showBack) { setBackExists(false); setShowBack(false); } }}
        />
        {banner && (
          <div className={`absolute bottom-0 left-0 right-0 ${banner.bg} text-white text-[9px] font-medium text-center py-0.5 rounded-b`}>
            {banner.text}
          </div>
        )}
        {backUrl && backExists && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowBack((s) => !s); }}
            className="absolute top-1 right-1 bg-background/80 rounded-full p-0.5 hover:bg-primary/20 transition-colors"
            title="Flip card"
          >
            <RotateCw className="h-3 w-3 text-primary" />
          </button>
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">{card.set_name}</span>
          {showWarning && (
            <Tooltip>
              <TooltipTrigger>
                <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
              </TooltipTrigger>
              <TooltipContent>{warningTooltip}</TooltipContent>
            </Tooltip>
          )}
          <span className="text-[10px] text-muted-foreground">#{card.collector_number}</span>
          <span className={`text-[10px] uppercase font-bold tracking-wider ${getRarityClass(card.rarity)}`}>
            {card.rarity}
          </span>
          {nonEnglish && (
            <Badge variant="outline" className="text-[10px] border-accent/50 text-accent gap-0.5 py-0">
              <Globe className="h-2.5 w-2.5" /> {card.language}
            </Badge>
          )}
        </div>

        {/* Variant buy buttons */}
        {allOutOfStock ? (
          <Badge variant="destructive" className="text-[10px]">Out of stock</Badge>
        ) : inStockVariants.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">Kontakta oss</span>
        ) : (
          <div className="flex items-center gap-1.5 flex-wrap">
            {inStockVariants.map((variant) => {
              const price = variant.is_foil ? variant.sell_price_foil_sek : variant.sell_price_sek;
              const displayPrice = getDiscountedPrice(variant);
              const canAdd = price !== null && price > 0;
              if (!canAdd) return null;

              const stock = variant.stock_a ?? variant.total_stock ?? 0;
              const cond = variant.condition ?? "NM";
              const isFoilVariant = variant.is_foil;

              const foilLabel = variant.special_foil_type ?? (isFoilVariant ? "Foil" : null);
              const specialPrintLabel = variant.special_print === "THE_LIST" ? "The List"
                : variant.special_print === "MYSTERY_BOOSTER" ? "Mystery Booster"
                : variant.special_print === "MYSTERY_BOOSTER_2" ? "Mystery Booster 2"
                : null;

              return (
                <div key={`${variant.scryfall_id}-${variant.condition}-${variant.is_foil}`} className="flex items-center gap-1 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    className={`h-7 text-xs border-primary/40 hover:bg-primary/10 ${isFoilVariant ? "text-orange-400 border-orange-400/40" : "text-primary"}`}
                    onClick={() => handleAdd(variant)}
                  >
                    <span>{cond}: {stock}{isFoilVariant ? "✨" : ""}</span>
                    <span className="mx-1">—</span>
                    <span className={isFoilVariant ? "text-orange-400" : ""}>{formatPrice(displayPrice)}</span>
                  </Button>
                  {foilLabel && foilLabel !== "Foil" && (
                    <span className="text-[10px] font-medium text-orange-300">{foilLabel}</span>
                  )}
                  {specialPrintLabel && (
                    <span className="text-[10px] font-medium text-teal-400">{specialPrintLabel}</span>
                  )}
                  {variant.condition_discount != null && variant.condition_discount > 0 && (
                    <span className="text-[10px] font-semibold text-red-400">-{Math.round(variant.condition_discount * 100)}%</span>
                  )}
                  {variant.is_signed && (
                    <span className="text-[10px] italic text-amber-500">✍ Signed</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
