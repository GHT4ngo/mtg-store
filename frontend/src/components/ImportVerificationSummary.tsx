import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ImportVerifyResponse } from "@/lib/importApi";

interface ImportVerificationSummaryProps {
  importId: number;
  importedCount: number;
  timestamp: string;
  verification: ImportVerifyResponse;
  onBack: () => void;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("sv-SE");
}

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "danger";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={tone === "danger" ? "mt-1 text-2xl font-bold text-destructive" : "mt-1 text-2xl font-bold text-foreground"}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

export default function ImportVerificationSummary({
  importId,
  importedCount,
  timestamp,
  verification,
  onBack,
}: ImportVerificationSummaryProps) {
  const failedRows = verification.rows.filter((row) => !row.verified);
  const allOk = verification.failed_count === 0 && verification.verified_count > 0;

  return (
    <section className="space-y-6">
      <div className="flex flex-col items-center gap-3 pt-4 text-center">
        {allOk ? (
          <CheckCircle2 className="h-16 w-16 text-green-500" />
        ) : (
          <AlertTriangle className="h-16 w-16 text-yellow-500" />
        )}

        <div>
          <h2 className="text-2xl font-display font-bold text-foreground">Verification summary</h2>
          <p className="text-sm text-muted-foreground">Import #{importId} completed and verified.</p>
        </div>
      </div>

      <div className={`grid gap-3 ${verification.failed_count > 0 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3"}`}>
        <StatCard label="Cards imported" value={verification.applied_count ?? importedCount} />
        <StatCard label="Verified in MySQL" value={verification.verified_count} />
        {verification.failed_count > 0 && <StatCard label="Failed" value={verification.failed_count} tone="danger" />}
        <StatCard label="Import ID" value={`#${importId}`} />
      </div>

      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Timestamp</p>
          <p className="mt-1 text-sm font-medium text-foreground">{formatTimestamp(timestamp)}</p>
        </CardContent>
      </Card>

      {allOk ? (
        <div className="rounded-lg border border-green-600/30 bg-green-600/10 p-4 text-sm font-medium text-green-700">
          All cards successfully imported and verified in MySQL
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-semibold text-destructive">Failed cards</p>
          <div className="overflow-auto rounded-lg border border-destructive/30">
            <Table>
              <TableHeader>
                <TableRow className="bg-destructive/10">
                  <TableHead className="text-destructive">Card name</TableHead>
                  <TableHead className="text-destructive">Reference</TableHead>
                  <TableHead className="text-right text-destructive">Expected stock</TableHead>
                  <TableHead className="text-right text-destructive">Actual stock</TableHead>
                  <TableHead className="text-destructive">Issue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failedRows.map((row, index) => (
                  <TableRow key={`${row.name}-${index}`} className="bg-destructive/5">
                    <TableCell className="text-xs font-medium text-foreground">{row.name}</TableCell>
                    <TableCell className="text-xs text-foreground">{row.actual_ref ?? row.reference ?? "–"}</TableCell>
                    <TableCell className="text-right text-xs text-foreground">{row.expected_stock}</TableCell>
                    <TableCell className="text-right text-xs font-medium text-destructive">{row.actual_stock}</TableCell>
                    <TableCell className="text-xs text-destructive">{row.issue ?? "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="flex justify-center pt-2">
        <Button onClick={onBack}>← Back to Import</Button>
      </div>
    </section>
  );
}