import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import SpaceBackground from "@/components/SpaceBackground";
import Index from "./pages/Index";
import Import from "./pages/Import";
import TradeIn from "./pages/TradeIn";
import TradeInLookup from "./pages/TradeInLookup";
import NotFound from "./pages/NotFound";
import Pricing from "./pages/Pricing";
import Admin from "./pages/Admin";
import Decklist from "./pages/Decklist";
import Analytics from "./pages/Analytics";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <div className="hidden md:block">
        <SpaceBackground />
      </div>
      <div className="relative z-10">
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/import" element={<Import />} />
            <Route path="/tradein" element={<TradeIn />} />
            <Route path="/tradein/check" element={<TradeInLookup />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/decklist" element={<Decklist />} />
            <Route path="/analytics" element={<Analytics />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </div>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
