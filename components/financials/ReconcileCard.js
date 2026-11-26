import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { formatCurrency } from "@/lib/format/currency";

const eur = (v) => formatCurrency(v);
const signed = (v) => (v > 0 ? `+ ${eur(v)}` : v < 0 ? `− ${eur(-v)}` : eur(0));
/**
 * Platform's line for "small" (the engine doesn't judge the difference, ADR-0055): within 1% of the year's income the
 * monthly figures are taken as reconciled.
 */
const SMALL_PCT = 1;

/**
 * cf.reconcile as a bridge, in plain words: profit in the accounts → what holds cash back or lets it in → the cash the
 * months should show → the cash they do show → what's unexplained. Every figure is an engine field.
 * `given`: the balances the farmer gave (milk owed, merchant credit), so a line left out is named, not hidden.
 */
export function CashBridge({ r, given }) {
  const b = r.bridge;
  const rows = [
    ["Profit in the accounts", eur(r.accounts_operating_profit), "strong", "Money made, plus the rise in herd and stock values"],
    ["Herd value change (not cash)", signed(b.herd_value_change), "sub"],
    ["Stock value change (not cash)", signed(b.stock_value_change), "sub"],
    ["Milk money still owed to you", signed(b.milk_debtors), "sub", given.milk ? "The co-op pays a month later" : "Not given: add it in Farm data"],
    ...(b.other_debtors ? [["Other money owed to you", signed(b.other_debtors), "sub"]] : []),
    ["Merchant and co-op credit", signed(b.merchant_credit), "sub", given.merchant ? "Bills you owe but haven’t paid yet" : "Not given: add it in Farm data"],
    ...(b.other_creditors ? [["Other bills not paid yet", signed(b.other_creditors), "sub"]] : []),
    ["Cash the months should show", eur(r.expected_operating_cash), "strong"],
    ["Cash the months do show", eur(r.actual_operating_cash), null, "Farm money in less farm money out, before loans, drawings and tax"],
  ];
  const small = Math.abs(r.unexplained_pct_of_revenue ?? 0) <= SMALL_PCT;
  return (
    <div className="text-sm">
      <table className="w-full max-w-xl">
        <tbody>
          {rows.map(([label, value, kind, hint]) => (
            <tr key={label} className={kind === "strong" ? "border-t border-stone-200 font-semibold" : "text-stone-700"}>
              <td className={`py-1 ${kind === "sub" ? "pl-4" : ""}`}>
                {label}
                {hint && <span className="block text-xs font-normal text-stone-500">{hint}</span>}
              </td>
              <td className="py-1 pl-3 text-right align-top whitespace-nowrap tabular-nums">{value}</td>
            </tr>
          ))}
          <tr className={`border-t-2 border-stone-300 font-semibold ${small ? "text-emerald-800" : "text-amber-800"}`}>
            <td className="py-1.5">Not explained</td>
            <td className="py-1.5 pl-3 text-right tabular-nums">
              {eur(r.unexplained)}
              <span className="block text-xs font-normal">{(r.unexplained_pct_of_revenue ?? 0).toLocaleString("en-IE", { maximumFractionDigits: 1 })}% of income</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-stone-600">
        {small
          ? "Your monthly figures and your profit agree. ✓"
          : "Worth a look: a missing invoice, a credit account you didn’t list, or cash sales not recorded usually explain a gap like this."}
      </p>
    </div>
  );
}

/** "Why is my cash different from my profit?" on Farm Financials. */
export default function ReconcileCard({ response, farm }) {
  const given = { milk: farm.year_end?.milk_owed_start != null || farm.year_end?.milk_owed_end != null, merchant: farm.year_end?.merchant_credit_start != null || farm.year_end?.merchant_credit_end != null };
  return (
    <Card
      title="Why is my cash different from my profit?"
      subtitle={`${farm.year}, what happened so far plus our forecast: from the profit in your accounts to the cash in your bank`}
      badge={<Badge>cf.reconcile</Badge>}
    >
      {response?.status === "ok" ? (
        <CashBridge r={response.result} given={given} />
      ) : (
        <p className="text-sm text-stone-600">
          Couldn’t work it out yet{response?.error?.message ? `: ${response.error.message}` : ""}.{" "}
          <Link href="/farm-data" className="underline">
            Check your figures in Farm data
          </Link>
        </p>
      )}
    </Card>
  );
}
