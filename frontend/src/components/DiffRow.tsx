import { useState } from "react";
import { Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { TableRow, TableCell } from "@/components/ui/table";
import CardImageHover from "@/components/CardImageHover";
import type { ImportRow } from "@/lib/importApi";

import { CONDITION_OPTIONS, conditionLabel } from "@/lib/conditions";

interface DiffRowProps {
  row: ImportRow;
  onUpdate: (updated: Partial<ImportRow>) => void;
}

export default function DiffRow({ row, onUpdate }: DiffRowProps) {
  const [editing, setEditing] = useState(false);
  const [editFoil, setEditFoil] = useState(row.foil);
  const [editCondition, setEditCondition] = useState(row.alphaspel_condition ?? row.condition);
  const [editQty, setEditQty] = useState(row.quantity);

  const isMismatch = row.match_status === "condition_mismatch";
  const isNotFound = row.match_status === "not_in_alphaspel";

  const rowClass = isNotFound
    ? "opacity-50"
    : isMismatch
    ? "bg-yellow-500/5"
    : "";

  const currentTotal = (row.current_stock_a ?? 0) + (row.current_stock_b ?? 0) + (row.current_stock_c ?? 0);
  const newVal = row.new_stock_value;

  const handleSave = () => {
    onUpdate({
      foil: editFoil,
      condition: editCondition,
      alphaspel_condition: editCondition,
      quantity: editQty,
    });
    setEditing(false);
  };

  const handleCancel = () => {
    setEditFoil(row.foil);
    setEditCondition(row.alphaspel_condition ?? row.condition);
    setEditQty(row.quantity);
    setEditing(false);
  };

  const renderBadge = () => {
    if (row.apply_error) {
      return <Badge className="bg-destructive/20 text-destructive border-destructive/30 text-[10px]">Failed: {row.apply_error}</Badge>;
    }
    if (row.apply_action === "inserted") {
      return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px]">Created</Badge>;
    }
    if (row.apply_action === "updated") {
      return <Badge className="bg-green-600/20 text-green-500 border-green-600/30 text-[10px]">Updated</Badge>;
    }
    if (row.match_status === "not_in_alphaspel") {
      return <Badge className="bg-destructive/20 text-destructive border-destructive/30 text-[10px]">Not in catalog</Badge>;
    }
    if (row.match_status === "condition_mismatch") {
      return <Badge className="bg-yellow-500/20 text-yellow-500 border-yellow-500/30 text-[10px]">Wrong condition</Badge>;
    }
    if (row.match_status === "zero_stock" && currentTotal === 0) {
      if (row.reference && row.reference.endsWith("-F")) {
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px]">New article</Badge>;
      }
      return <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-[10px]">Activate +{row.delta}</Badge>;
    }
    return <Badge className="bg-green-600/20 text-green-500 border-green-600/30 text-[10px]">+{row.delta}</Badge>;
  };

  return (
    <TableRow className={rowClass}>
      <TableCell className="text-xs font-medium max-w-[200px] truncate">
        <div className="flex items-center gap-1.5">
          {row.image_url_small ? (
            <CardImageHover src={row.image_url_small} alt={row.name}>
              <img src={row.image_url_small} alt="" className="w-6 h-6 rounded-sm object-cover flex-shrink-0 cursor-pointer" />
            </CardImageHover>
          ) : null}
          <span className="truncate">{row.name}</span>
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground uppercase">{row.set_code}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{row.collector_number}</TableCell>
      <TableCell className="text-xs text-center">
        {editing ? (
          <Checkbox
            checked={editFoil === "foil"}
            onCheckedChange={(v) => setEditFoil(v ? "foil" : "normal")}
          />
        ) : (
          row.foil === "foil" ? "✨" : ""
        )}
      </TableCell>
      <TableCell className="text-xs">
        {editing ? (
          <Select value={editCondition} onValueChange={setEditCondition}>
            <SelectTrigger className="h-7 w-16 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CONDITION_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.value}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          row.alphaspel_condition ?? row.condition ?? "NM"
        )}
      </TableCell>
      <TableCell className="text-xs text-right font-medium">
        {editing ? (
          <Input
            type="number"
            min={0}
            value={editQty}
            onChange={(e) => setEditQty(Math.max(0, parseInt(e.target.value) || 0))}
            className="h-7 w-16 text-xs text-right"
          />
        ) : (
          row.quantity
        )}
      </TableCell>
      <TableCell className="text-xs text-right font-medium">
        {row.sell_price_sek != null ? `${row.sell_price_sek} kr` : "–"}
      </TableCell>
      <TableCell className="text-xs text-right font-medium">
        {isNotFound ? "–" : `${currentTotal}→${newVal ?? "–"}`}
      </TableCell>
      <TableCell>{renderBadge()}</TableCell>
      <TableCell className="text-xs">
        {editing ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSave}>
              <Check className="h-3 w-3 text-green-500" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCancel}>
              <X className="h-3 w-3 text-destructive" />
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
