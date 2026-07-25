import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export interface CartItem {
  scryfall_id: string;
  name: string;
  set_name: string;
  collector_number: string;
  condition: string; // NM, GD, HP
  is_foil: boolean;
  sell_price_sek: number;
  quantity: number;
}

function cartItemKey(item: Pick<CartItem, "scryfall_id" | "condition" | "is_foil">) {
  return `${item.scryfall_id}|${item.condition}|${item.is_foil}`;
}

interface CartContextType {
  items: CartItem[];
  addItem: (item: Omit<CartItem, "quantity">, maxStock?: number) => boolean;
  removeItem: (key: string) => void;
  updateQuantity: (key: string, delta: number, maxStock?: number) => void;
  totalItems: number;
  subtotal: number;
  getKey: (item: Pick<CartItem, "scryfall_id" | "condition" | "is_foil">) => string;
  generateMailto: () => string;
}

const CartContext = createContext<CartContextType | null>(null);

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);

  const addItem = useCallback((item: Omit<CartItem, "quantity">, maxStock?: number): boolean => {
    const key = cartItemKey(item);
    let blocked = false;
    setItems((prev) => {
      const existing = prev.find((i) => cartItemKey(i) === key);
      if (existing) {
        if (maxStock !== undefined && existing.quantity >= maxStock) {
          blocked = true;
          return prev;
        }
        const newQty = existing.quantity + 1;
        if (maxStock !== undefined && newQty > maxStock) {
          blocked = true;
          return prev;
        }
        return prev.map((i) => cartItemKey(i) === key ? { ...i, quantity: newQty } : i);
      }
      if (maxStock !== undefined && maxStock < 1) {
        blocked = true;
        return prev;
      }
      return [...prev, { ...item, quantity: 1 }];
    });
    return !blocked;
  }, []);

  const removeItem = useCallback((key: string) => {
    setItems((prev) => prev.filter((i) => cartItemKey(i) !== key));
  }, []);

  const updateQuantity = useCallback((key: string, delta: number, maxStock?: number) => {
    setItems((prev) => prev.map((i) => {
      if (cartItemKey(i) !== key) return i;
      const newQty = i.quantity + delta;
      if (newQty <= 0) return i;
      if (maxStock !== undefined && newQty > maxStock) return i;
      return { ...i, quantity: newQty };
    }).filter((i) => i.quantity > 0));
  }, []);

  const totalItems = items.reduce((s, i) => s + i.quantity, 0);
  const subtotal = items.reduce((s, i) => s + i.sell_price_sek * i.quantity, 0);

  const getKey = useCallback((item: Pick<CartItem, "scryfall_id" | "condition" | "is_foil">) => cartItemKey(item), []);

  const generateMailto = useCallback(() => {
    const lines = items.map((i) =>
      `${i.quantity}x ${i.name} [${i.set_name}] #${i.collector_number} ${i.condition}${i.is_foil ? " ✨" : ""} - ${Math.round(i.sell_price_sek)} kr`
    );
    lines.push("", `Totalt: ${Math.round(subtotal)} kr`);
    const body = encodeURIComponent(lines.join("\n"));
    const subject = encodeURIComponent("Kortbeställning från LGS Singles");
    return `mailto:orders@lgs.se?subject=${subject}&body=${body}`;
  }, [items, subtotal]);

  return (
    <CartContext.Provider value={{ items, addItem, removeItem, updateQuantity, totalItems, subtotal, getKey, generateMailto }}>
      {children}
    </CartContext.Provider>
  );
}
