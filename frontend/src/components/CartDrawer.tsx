import { useCart } from "./CartContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ShoppingCart, Plus, Minus, Trash2, Send } from "lucide-react";
import { formatPrice } from "@/lib/api";

interface CartDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function CartDrawer({ open, onClose }: CartDrawerProps) {
  const { items, removeItem, updateQuantity, subtotal, getKey, generateMailto } = useCart();

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex flex-col w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-display flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" /> Varukorg
          </SheetTitle>
          <SheetDescription>
            {items.length === 0 ? "Din varukorg är tom" : `${items.length} artikel(er)`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto space-y-2 py-4">
          {items.map((item) => {
            const key = getKey(item);
            return (
              <div key={key} className="flex items-start gap-3 p-3 bg-secondary/50 rounded-lg">
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {item.set_name} #{item.collector_number} · {item.condition}
                    {item.is_foil && " · Foil"}
                  </p>
                  <p className="text-sm font-semibold text-primary">{formatPrice(item.sell_price_sek)}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => updateQuantity(key, -1)}
                  >
                    <Minus className="h-3 w-3" />
                  </Button>
                  <span className="text-sm font-medium w-6 text-center">{item.quantity}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => updateQuantity(key, 1)}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive"
                    onClick={() => removeItem(key)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {items.length > 0 && (
          <div className="border-t border-border pt-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Subtotal</span>
              <span className="text-lg font-bold text-primary">{formatPrice(subtotal)}</span>
            </div>
            <Button asChild className="w-full gap-2">
              <a href={generateMailto()}>
                <Send className="h-4 w-4" /> Skicka förfrågan
              </a>
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
