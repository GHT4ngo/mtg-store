import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Search, Loader2, X } from "lucide-react";

export interface AIChip {
  label: string;
  param: string;
  value: string | boolean | number;
}

interface AISearchBarProps {
  chips: AIChip[];
  onSearch: (query: string) => void;
  onRemoveChip: (param: string) => void;
  onClearAll: () => void;
  isSearching: boolean;
}

export default function AISearchBar({
  chips,
  onSearch,
  onRemoveChip,
  onClearAll,
  isSearching,
}: AISearchBarProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    onSearch(trimmed);
  };

  return (
    <div className="space-y-2">
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Sparkles className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary" />
          <Input
            placeholder="Ask me anything… e.g. blue rare creatures in stock"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            className="pl-10 bg-secondary border-border h-11 text-base"
            disabled={isSearching}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
            AI Search
          </span>
        </div>
        <Button
          onClick={handleSubmit}
          disabled={isSearching || !query.trim()}
          className="h-11 px-4 gap-2"
        >
          {isSearching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Search
        </Button>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Badge
              key={chip.param}
              variant="secondary"
              className="gap-1 pl-2.5 pr-1 py-1 text-xs"
            >
              {chip.label}
              <button
                onClick={() => onRemoveChip(chip.param)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <button
            onClick={onClearAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
