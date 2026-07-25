import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchStats } from "@/lib/api";
import { Package, Store, ListOrdered, ArrowLeftRight, ClipboardCheck, DollarSign, Shield, BarChart2 } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { ChangelogModal } from "@/components/ChangelogModal";

const navItems = [
  { to: "/", label: "Shop", icon: Store },
  { to: "/decklist", label: "Decklist", icon: ListOrdered },
  { to: "/tradein", label: "Trade In", icon: ArrowLeftRight },
  { to: "/tradein/check", label: "Check Trade-In", icon: ClipboardCheck },
  { to: "/pricing", label: "Pricing", icon: DollarSign },
  { to: "/analytics", label: "Analytics", icon: BarChart2 },
  { to: "/admin", label: "Admin", icon: Shield },
];

export default function StoreHeader() {
  const [changelogOpen, setChangelogOpen] = useState(false);
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    staleTime: 60000,
  });

  return (
    <header className="border-b border-border bg-card">
      <div className="container py-2 md:py-4 flex flex-col gap-2">
        {/* Top row: title + stats */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg md:text-3xl font-display font-bold relative">
            <span className="gold-shimmer relative">
              <span className="relative">
                <span className="line-through decoration-[3px] decoration-destructive/70 opacity-50" style={{ color: "hsl(210 60% 55%)" }}>Alphaspel</span>
              </span>
              <span className="absolute -top-1 left-0 -rotate-3 text-primary font-bold tracking-wide" style={{ fontFamily: "'Caveat', cursive", WebkitTextFillColor: "hsl(43 80% 55%)", fontSize: "1.3em" }}>
                Betaspel
              </span>
              {" "}Singles
            </span>
          </h1>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {stats && (
              <span className="flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5 text-primary" />
                <span className="text-foreground font-medium">{stats.cards_in_stock.toLocaleString()}</span>
                <span className="hidden sm:inline">in stock</span>
              </span>
            )}
            <button
              onClick={() => setChangelogOpen(true)}
              className="hidden sm:inline text-muted-foreground/50 hover:text-muted-foreground font-mono text-[10px] tracking-wider transition-colors cursor-pointer"
            >
              Build Alpha 1.2
            </button>
          </div>
        </div>
        <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />

        {/* Nav row: icons on mobile, text on desktop */}
        <nav className="flex items-center justify-between md:justify-start md:gap-1 border-t border-border/50 pt-2 md:border-0 md:pt-0">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className="flex flex-col md:flex-row items-center gap-0.5 md:gap-1.5 px-2 md:px-3 py-1.5 rounded-md text-[10px] md:text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-all duration-200"
              activeClassName="text-primary font-medium"
            >
              <Icon className="h-5 w-5 md:h-4 md:w-4" />
              <span className="md:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
