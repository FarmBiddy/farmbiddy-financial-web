import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { formatCurrency } from "@/lib/format/currency";
import { dayLabel, monthLabel } from "@/lib/format/date";
import { payDate } from "@/lib/financials/tax";

const eur = (v) => formatCurrency(v);
const BASIS = {
  current_90: "90% of this year’s tax",
  prior_100: "100% of last year’s tax",
  pre_preceding_105_dd: "105% of the year before last, by direct debit",
};
/** Platform data (2026 Department of Agriculture payment calendar): when scheme money usually lands around tax time. */
const SCHEME_MONEY = "BISS and Eco-Scheme advances usually arrive mid to late October, the balance from December.";

/**
 * "Tax due this autumn" from tax.payments (ADR-0055): the bill on the pay date (last year's balance + this year's
 * preliminary), the three ways preliminary tax can be worked out, and what's left for next year. `cashMonths`: the
 * cf.months result, to say if the bank balance goes below zero once the bill is paid. Every figure is the engine's.
 */
export default function TaxDueCard({ payments, left = [], thisYear, taxCash, cashMonths, year, compact = false }) {
  const title = "Tax due this autumn";
  if (!payments) {
    return (
      <Card title={title} subtitle="Preliminary tax and last year’s balance, paid together" badge={<Badge>tax.payments</Badge>}>
        <p className="text-sm text-stone-700">
          {left.length ? `To work out your autumn tax bill we need: ${left.join(", ")}.` : "We need your tax estimate first."}{" "}
          <Link href="/farm-data" className="font-medium text-emerald-800 underline">
            Answer in Farm data
          </Link>
        </p>
      </Card>
    );
  }
  if (payments.status !== "ok") {
    return (
      <Card title={title} badge={<Badge>tax.payments</Badge>}>
        <p className="text-sm text-stone-600">Couldn’t work it out: {payments.error?.message ?? payments.missing?.map((m) => m.field).join(", ")}.</p>
      </Card>
    );
  }
  const p = payments.result;
  const due = payDate(p);
  const dd = p.direct_debit_instalments;
  // The months the bill is paid in, and the first of them where the forecast bank balance is below zero.
  const paid = [...(taxCash?.keys() ?? [])];
  const short = cashMonths?.find((m) => m.period.year === year && paid.some((x) => m.period.month >= x) && m.closing_cash < 0);

  return (
    <Card
      title={title}
      subtitle={`An estimate, confirm with your accountant · ${year}’s tax taken as ${eur(p.options.find((o) => o.basis === "current_90")?.base_tax ?? thisYear?.amount)} (${thisYear?.source === "accountant" ? "your accountant’s figure in Farm data" : "our estimate"})`}
      badge={<Badge>tax.payments</Badge>}
    >
      <p className="text-sm text-stone-700">
        About <strong className="tabular-nums text-lg">{eur(p.due_on_pay_date)}</strong> to pay by <strong>{dayLabel(due)} {due.slice(0, 4)}</strong>
        {p.pay_date.ros ? ` (filing on ROS; ${dayLabel(p.pay_date.statutory)} otherwise)` : ""}.
      </p>
      <table className="mt-2 w-full max-w-md text-sm">
        <tbody className="text-stone-700">
          {!dd && (
            <tr>
              <td className="py-0.5">Preliminary tax for {year}</td>
              <td className="py-0.5 text-right tabular-nums">{eur(p.preliminary.amount)}</td>
            </tr>
          )}
          <tr>
            <td className="py-0.5">What’s left of your {p.preceding_year.tax_year} tax</td>
            <td className="py-0.5 text-right tabular-nums">{eur(p.preceding_year.balance_due)}</td>
          </tr>
          <tr className="border-t border-stone-200 font-semibold">
            <td className="py-0.5">Due on {dayLabel(due)}</td>
            <td className="py-0.5 text-right tabular-nums">{eur(p.due_on_pay_date)}</td>
          </tr>
        </tbody>
      </table>
      {p.preceding_year.overpaid > 0 && (
        <p className="mt-1 text-xs text-stone-600">You overpaid {eur(p.preceding_year.overpaid)} for {p.preceding_year.tax_year}: Revenue refunds or offsets it, it isn’t taken off the bill above.</p>
      )}

      {short && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200">
          ⚠ After paying it, your bank balance is forecast to be {eur(short.closing_cash)} at the end of {monthLabel(short.period.month)}. Talk to your bank or
          accountant before then.
        </p>
      )}

      {!compact && (
        <>
          {dd && (
            <p className="mt-3 text-sm text-stone-700">
              By direct debit: {eur(dd[0].amount)} a month on the 9th, {monthLabel(dd[0].month)}–{monthLabel(dd.at(-1).month)} ({eur(p.preliminary.amount)} preliminary tax in
              all), so only last year’s balance is due on {dayLabel(due)}.
            </p>
          )}
          <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-stone-500">Three ways to work out preliminary tax</p>
          <table className="mt-1 w-full text-sm">
            <tbody className="divide-y divide-stone-100">
              {p.options.map((o) => (
                <tr key={o.basis} className={o.available ? "text-stone-700" : "text-stone-400"}>
                  <td className="py-1">
                    {BASIS[o.basis] ?? o.basis}
                    {o.basis === p.preliminary.basis && <span className="ml-2 rounded-full bg-emerald-100 px-1.5 text-[11px] text-emerald-900">yours</span>}
                    {o.basis === p.lowest_safe.basis && <span className="ml-2 rounded-full bg-sky-100 px-1.5 text-[11px] text-sky-900">lowest that avoids interest</span>}
                    {!o.available && <span className="block text-xs">{o.requires_direct_debit ? "Only by direct debit, and not after a year with no tax" : "Not available"}</span>}
                  </td>
                  <td className="py-1 text-right tabular-nums">{eur(o.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-stone-500">
            {p.next_year.balance_due > 0
              ? `Next autumn: about ${eur(p.next_year.balance_due)} more for ${year}, on top of next year’s preliminary tax.`
              : p.next_year.overpaid > 0
                ? `Next autumn: about ${eur(p.next_year.overpaid)} of ${year}’s preliminary tax comes back or is offset.`
                : `Nothing more expected for ${year} next autumn.`}{" "}
            {SCHEME_MONEY} The payment is in your cash forecast as an estimate.
          </p>
        </>
      )}
    </Card>
  );
}
