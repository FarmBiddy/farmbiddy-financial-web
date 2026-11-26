import { DSCR_OK } from "@/components/financials/StatusTiles";
import { isProjected } from "@/lib/financials/farm";
import { formatCurrency } from "@/lib/format/currency";
import { dayLabel, monthLabel } from "@/lib/format/date";

/**
 * Things worth a look, from platform records and engine results (comparisons only, no maths).
 * Shared by the dashboard and the advisor portfolio.
 * @returns {{ tone: "bad" | "warn", text: string, href: string }[]}
 */
export function attention(farm, { plf, pl, kpi, cff, cf, loans, taxCash }) {
  const items = [];
  if (cf.status === "ok") {
    // the autumn tax bill (tax.payments, in the cash forecast): flagged in the month it's paid if it takes the bank below zero
    for (const [month, amount] of taxCash ?? []) {
      const m = cf.result.months.find((x) => x.period.year === farm.year && x.period.month === month);
      if (m?.closing_cash < 0) {
        items.push({ tone: "bad", text: `Tax bill of about ${formatCurrency(amount)} in ${monthLabel(month)} takes your bank balance to ${formatCurrency(m.closing_cash)}`, href: "/farm-financials" });
      }
    }
    for (const m of cf.result.months.filter((m) => isProjected(farm, m.period.month) && m.closing_cash < 0)) {
      items.push({ tone: "bad", text: `Projected overdraft at the end of ${monthLabel(m.period.month)} (${formatCurrency(m.closing_cash)})`, href: "/farm-financials" });
    }
  }
  const dscr = kpi.status === "ok" ? kpi.result.dscr : null;
  if (dscr != null && dscr < DSCR_OK) {
    items.push({ tone: dscr < 1 ? "bad" : "warn", text: `Loan cover is ${dscr.toLocaleString("en-IE", { maximumFractionDigits: 2 })}× — lenders look for ${DSCR_OK}×`, href: "/farm-financials" });
  }
  for (const s of farm.suppliers?.suppliers ?? []) {
    if (s.overdue) items.push({ tone: "bad", text: `${s.name}: ${formatCurrency(s.balance)} overdue since ${dayLabel(s.due_date)}`, href: "/farm-financials" });
  }
  if ([loans, pl, kpi, cf].some((r) => r?.status === "needs_input")) {
    items.push({ tone: "warn", text: "Biddy needs a figure from you to finish your numbers", href: "/farm-financials" });
  }
  if ([plf, cff].some((r) => r && r.status !== "ok")) {
    items.push({ tone: "warn", text: "The forecast couldn’t run — showing actual months only", href: "/farm-financials" });
  }
  return items;
}
