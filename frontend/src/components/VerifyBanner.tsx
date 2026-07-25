import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import type { ImportVerifyResponse } from "@/lib/importApi";

interface VerifyBannerProps {
  data: ImportVerifyResponse;
}

export default function VerifyBanner({ data }: VerifyBannerProps) {
  const failedRows = data.rows.filter((r) => !r.verified);
  const allGreen = failedRows.length === 0 && data.verified_count > 0;

  return (
    <div className="space-y-3">
      {/* Status bar */}
      {allGreen ? (
        <div className="flex items-center gap-2 bg-green-600/10 border border-green-600/30 rounded-lg p-3">
          <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
          <p className="text-sm font-medium text-green-500">
            ✓ {data.verified_count} / {data.verified_count} cards verified in MySQL
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
          <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0" />
          <p className="text-sm font-medium text-yellow-500">
            ⚠ {data.verified_count} verified, {data.failed_count} FAILED — see below
          </p>
        </div>
      )}

      {/* Failed cards table */}
      {failedRows.length > 0 && (
        <div className="border-2 border-destructive/40 rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-destructive/10">
                <TableHead className="text-xs text-destructive">Card name</TableHead>
                <TableHead className="text-xs text-destructive">Reference</TableHead>
                <TableHead className="text-xs text-destructive">Condition</TableHead>
                <TableHead className="text-xs text-destructive text-right">Expected → Actual</TableHead>
                <TableHead className="text-xs text-destructive">Issue</TableHead>
                <TableHead className="text-xs text-destructive">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failedRows.map((row, i) => {
                const refMismatch = row.actual_ref && row.actual_ref !== row.reference;
                const condNull = row.actual_cond === null;
                const condMismatch = row.actual_cond !== undefined && row.actual_cond !== row.condition;
                const stockMismatch = row.expected_stock !== row.actual_stock;

                return (
                  <TableRow key={i} className="bg-destructive/5">
                    <TableCell className="text-xs font-medium">
                      {row.name}
                      <span className="text-muted-foreground ml-1">({row.set_code} #{row.collector_number})</span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {refMismatch ? (
                        <span className="text-destructive font-medium">{row.actual_ref}</span>
                      ) : (
                        <span className="text-muted-foreground">{row.reference ?? "–"}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {condNull ? (
                        <Badge className="bg-destructive/20 text-destructive border-destructive/30 text-[10px]">NULL</Badge>
                      ) : condMismatch ? (
                        <span className="text-destructive font-medium">{row.actual_cond}</span>
                      ) : (
                        <span className="text-muted-foreground">{row.condition ?? "–"}</span>
                      )}
                    </TableCell>
                    <TableCell className={`text-xs text-right font-medium ${stockMismatch ? "text-destructive" : ""}`}>
                      {row.expected_stock} → {row.actual_stock}
                    </TableCell>
                    <TableCell className="text-xs text-destructive/80">
                      {row.issue ?? "–"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.updated_at ? new Date(row.updated_at).toLocaleString("sv-SE") : "–"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
