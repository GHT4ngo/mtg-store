import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchCards, aiSearch, groupCardsByName, type Card, type CardGroup } from "@/lib/api";
import SearchFilters, { type Filters } from "@/components/SearchFilters";
import AISearchBar, { type AIChip } from "@/components/AISearchBar";
import GroupedCardTile from "@/components/GroupedCardTile";
import CardDetailModal from "@/components/CardDetailModal";
import StoreHeader from "@/components/StoreHeader";
import Pagination from "@/components/Pagination";
import CartDrawer from "@/components/CartDrawer";
import { CartProvider, useCart } from "@/components/CartContext";
import { AlertCircle, RefreshCw, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const GROUPS_PER_PAGE = 20;

function CartFab() {
  const { totalItems } = useCart();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 bg-primary text-primary-foreground rounded-full w-14 h-14 flex items-center justify-center shadow-lg hover:bg-primary/90 transition-colors"
      >
        <ShoppingCart className="h-6 w-6" />
        {totalItems > 0 && (
          <span className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground text-xs font-bold rounded-full h-5 min-w-5 flex items-center justify-center px-1">
            {totalItems}
          </span>
        )}
      </button>
      <CartDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}

const IndexContent = () => {
  const [filters, setFilters] = useState<Filters | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [displayPage, setDisplayPage] = useState(1);
  const [aiChips, setAiChips] = useState<AIChip[]>([]);
  const [aiFilters, setAiFilters] = useState<Record<string, string | boolean | number>>({});
  const [isAiSearching, setIsAiSearching] = useState(false);
  const [aiDropName, setAiDropName] = useState(false);

  const mergedQueryParams = useMemo(() => {
    const base: Record<string, any> = {};
    if (filters) {
      if (filters.name && !aiDropName) base.name = filters.name;
      if (filters.set_code) base.set_code = filters.set_code;
      if (filters.rarity) base.rarity = filters.rarity;
      if (filters.foil) base.foil = true;
    }
    // AI filters layer on top
    for (const [k, v] of Object.entries(aiFilters)) {
      if (v !== undefined && v !== "" && v !== false) base[k] = v;
    }
    // Persistent UI toggles always win — applied last
    if (filters?.in_stock) base.in_stock = true;
    base.page = 1;
    base.page_size = 100;
    return base;
  }, [filters, aiFilters, aiDropName]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["cards", mergedQueryParams],
    queryFn: () => fetchCards(mergedQueryParams),
    enabled: filters !== null || Object.keys(aiFilters).length > 0,
  });

  const groups = useMemo(() => {
    if (!data?.cards) return [];
    let cards = data.cards;
    if (filters?.set_codes_in_group && filters.set_codes_in_group.length > 0 && !filters.set_code) {
      const codeSet = new Set(filters.set_codes_in_group);
      cards = cards.filter((c) => codeSet.has(c.set_code));
    }
    return groupCardsByName(cards);
  }, [data, filters?.set_codes_in_group, filters?.set_code]);

  const totalGroupPages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const pagedGroups = groups.slice((displayPage - 1) * GROUPS_PER_PAGE, displayPage * GROUPS_PER_PAGE);

  const handleFiltersChange = useCallback((newFilters: Filters) => {
    setFilters(newFilters);
    setAiDropName(false);
    setDisplayPage(1);
  }, []);

  const handlePageChange = useCallback((p: number) => {
    setDisplayPage(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleInitialLoad = useCallback(() => {
    setFilters({ name: "", set_code: "", set_codes_in_group: [], rarity: "", in_stock: true, foil: false });
  }, []);

  const handleAiSearch = useCallback(async (query: string) => {
    setIsAiSearching(true);
    try {
      const result = await aiSearch(query);
      const currentName = filters?.name?.trim() ?? "";

      let shouldDropName = false;
      if (currentName) {
        // Probe: check if combining AI filters + search text yields results
        const probeParams: Record<string, any> = { ...result.filters, name: currentName, page_size: 1 };
        try {
          const probe = await fetchCards(probeParams);
          if ((probe.total ?? 0) === 0) {
            shouldDropName = true;
          }
        } catch {
          // On probe error, drop name to be safe
          shouldDropName = true;
        }
      }

      setAiDropName(shouldDropName);
      setAiFilters(result.filters);
      setAiChips(result.chips);
      if (!filters) {
        setFilters({ name: "", set_code: "", set_codes_in_group: [], rarity: "", in_stock: true, foil: false });
      }
      setDisplayPage(1);
    } catch {
      toast.error("AI search failed — try a different query");
    } finally {
      setIsAiSearching(false);
    }
  }, [filters]);

  const handleRemoveChip = useCallback((param: string) => {
    setAiChips((prev) => prev.filter((c) => c.param !== param));
    setAiFilters((prev) => {
      const next = { ...prev };
      delete next[param];
      return next;
    });
    setAiDropName(false);
    setDisplayPage(1);
  }, []);

  const handleClearAllChips = useCallback(() => {
    setAiChips([]);
    setAiFilters({});
    setAiDropName(false);
    setDisplayPage(1);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <StoreHeader />

      <main className="container py-6 space-y-6">
        <AISearchBar
          chips={aiChips}
          onSearch={handleAiSearch}
          onRemoveChip={handleRemoveChip}
          onClearAll={handleClearAllChips}
          isSearching={isAiSearching}
        />
        <SearchFilters onFiltersChange={handleFiltersChange} isLoading={isLoading} />

        {isError && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground space-y-4">
            <AlertCircle className="h-10 w-10 text-destructive" />
            <p className="text-sm">Could not connect to store database. Please try again later.</p>
            <Button variant="outline" onClick={() => refetch()} className="gap-2 border-primary/40 text-primary">
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          </div>
        )}

        {filters === null && !isError && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <h2 className="text-2xl font-display font-bold text-foreground">Welcome to Betaspel Singles</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Search for Magic: The Gathering cards above, or browse the full inventory.
            </p>
            <Button onClick={handleInitialLoad} className="gap-2">
              Browse All Cards
            </Button>
          </div>
        )}

        {filters !== null && !isError && (
          <>
            {isLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-2">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="rounded-lg border border-border bg-card p-3 space-y-2 animate-pulse">
                    <div className="h-4 w-3/4 rounded bg-muted" />
                    <div className="h-3 w-1/2 rounded bg-muted" />
                    <div className="h-3 w-1/3 rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <p className="text-lg font-display">No cards found{filters.name ? ` for "${filters.name}"` : ""}</p>
                <p className="text-sm mt-1">Try adjusting your search or filters</p>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Showing {(displayPage - 1) * GROUPS_PER_PAGE + 1}–{Math.min(displayPage * GROUPS_PER_PAGE, groups.length)} of {groups.length} card names ({data?.total.toLocaleString()} total printings)
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-2">
                  {pagedGroups.map((group) => (
                    <GroupedCardTile
                      key={group.name}
                      group={group}
                      onImageClick={setSelectedCard}
                    />
                  ))}
                </div>

                {totalGroupPages > 1 && (
                  <Pagination
                    page={displayPage}
                    totalPages={totalGroupPages}
                    onPageChange={handlePageChange}
                  />
                )}
              </>
            )}
          </>
        )}
      </main>

      <CartFab />

      <CardDetailModal
        card={selectedCard}
        open={!!selectedCard}
        onClose={() => setSelectedCard(null)}
      />
    </div>
  );
};

const Index = () => (
  <CartProvider>
    <IndexContent />
  </CartProvider>
);

export default Index;
