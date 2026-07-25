import { useState, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Search, Loader2 } from "lucide-react";

export interface Filters {
  name: string;
  set_code: string;
  set_codes_in_group: string[];
  rarity: string;
  in_stock: boolean;
  foil: boolean;
}

interface SearchFiltersProps {
  onFiltersChange: (filters: Filters) => void;
  isLoading: boolean;
}

export default function SearchFilters({ onFiltersChange, isLoading }: SearchFiltersProps) {
  const [name, setName] = useState("");
  const [inStock, setInStock] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const emitFilters = useCallback((overrides?: Partial<Filters>) => {
    const f: Filters = {
      name,
      set_code: "",
      set_codes_in_group: [],
      rarity: "",
      in_stock: inStock,
      foil: false,
      ...overrides,
    };
    onFiltersChange(f);
  }, [name, inStock, onFiltersChange]);

  const handleNameChange = (value: string) => {
    setName(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      emitFilters({ name: value });
    }, 400);
  };

  const handleInStockChange = (checked: boolean) => {
    setInStock(checked);
    emitFilters({ in_stock: checked });
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        {isLoading ? (
          <Loader2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary animate-spin" />
        ) : (
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        )}
        <Input
          placeholder="Search cards by name..."
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          className="pl-10 bg-secondary border-border h-11 text-base"
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch id="in-stock" checked={inStock} onCheckedChange={handleInStockChange} />
        <Label htmlFor="in-stock" className="text-sm text-muted-foreground whitespace-nowrap">In Stock</Label>
      </div>
    </div>
  );
}
