import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { Card } from "@/lib/api";
import { getSellPrice, getDiscountedPrice, formatPrice, isNonEnglish, getBackFaceUrl } from "@/lib/api";
import { Sparkles, Package, Globe, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Props {
  card: Card | null;
  open: boolean;
  onClose: () => void;
}

function getRarityClass(rarity: string) {
  switch (rarity?.toLowerCase()) {
    case "uncommon": return "text-rarity-uncommon";
    case "rare": return "text-rarity-rare";
    case "mythic": return "text-rarity-mythic";
    default: return "text-rarity-common";
  }
}

export default function CardDetailModal({ card, open, onClose }: Props) {
  const [showBack, setShowBack] = useState(false);
  const [backExists, setBackExists] = useState(true);

  if (!card) return null;

  const sellPrice = getDiscountedPrice(card);
  const nonEnglish = isNonEnglish(card);
  const backUrl = getBackFaceUrl(card);
  const currentImageUrl = (backUrl && showBack && backExists) ? backUrl : card.image_url_normal;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-card border-border p-0 overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="flex flex-col md:flex-row">
          <div className="md:w-1/2 bg-secondary/50 flex items-center justify-center p-6 relative">
            <img
              src={currentImageUrl}
              alt={card.name}
              className="max-h-[420px] rounded-lg shadow-2xl"
              onError={() => { if (showBack) { setBackExists(false); setShowBack(false); } }}
            />
            {backUrl && backExists && (
              <button
                onClick={() => setShowBack((s) => !s)}
                className="absolute bottom-8 right-8 bg-background/80 rounded-full p-2 hover:bg-primary/20 transition-colors"
                title="Flip card"
              >
                <RotateCw className="h-5 w-5 text-primary" />
              </button>
            )}
          </div>
          <div className="md:w-1/2 p-6 space-y-4">
            <div>
              <h2 className="text-xl font-display font-bold text-foreground">{card.name}</h2>
              <p className="text-sm text-muted-foreground mt-1">{card.type_line}</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={`${getRarityClass(card.rarity)} border-current`}>
                {card.rarity}
              </Badge>
              {card.is_foil && (
                <Badge className="bg-primary text-primary-foreground">
                  <Sparkles className="h-3 w-3 mr-1" /> Foil
                </Badge>
              )}
              {nonEnglish && (
                <Badge variant="outline" className="border-accent/50 text-accent">
                  <Globe className="h-3 w-3 mr-1" /> {card.language}
                </Badge>
              )}
              {card.is_signed && (
                <p className="text-xs italic text-amber-500">✍ Signed by {card.artist}</p>
              )}
              {card.in_stock ? (
                <Badge variant="outline" className="text-primary border-primary/50">
                  <Package className="h-3 w-3 mr-1" /> {card.total_stock} in stock
                </Badge>
              ) : (
                <Badge variant="destructive">Out of Stock</Badge>
              )}
            </div>

            {card.mana_cost && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Mana Cost</p>
                <p className="text-sm text-foreground">{card.mana_cost}</p>
              </div>
            )}

            {/* Condition & Stock */}
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Condition & Stock</p>
              <div className="flex gap-4 text-sm">
                <span>Condition: <span className="text-foreground font-medium">{card.condition ?? "–"}</span></span>
                <span>Stock: <span className="text-foreground font-medium">{card.total_stock} st</span></span>
              </div>
              {card.condition_discount != null && card.condition_discount > 0 && (
                <p className="text-xs text-accent mt-1">Condition discount: -{Math.round(card.condition_discount * 100)}%</p>
              )}
            </div>

            {/* Sell Price - highlighted */}
            <div className={`border rounded-lg p-3 ${nonEnglish ? "bg-accent/10 border-accent/30" : "bg-primary/10 border-primary/30"}`}>
              <p className={`text-[10px] uppercase tracking-wider font-semibold ${nonEnglish ? "text-accent" : "text-primary"}`}>
                {card.is_foil ? "Foil pris" : "Pris"}
                {nonEnglish && " (-10% språk)"}
              </p>
              <p className={`text-2xl font-bold ${nonEnglish ? "text-accent" : "text-primary"}`}>{formatPrice(sellPrice)}</p>
            </div>

            <div className="pt-2 border-t border-border space-y-1">
              <p className="text-xs text-muted-foreground">
                <span className="text-foreground">{card.set_name}</span> · #{card.collector_number}
              </p>
              <p className="text-xs text-muted-foreground">
                Artist: <span className="text-foreground">{card.artist}</span>
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
