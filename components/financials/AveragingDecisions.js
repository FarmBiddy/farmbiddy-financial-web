import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { formatCurrency } from "@/lib/format/currency";
import { dayLabel } from "@/lib/format/date";

const eur = (v) => formatCurrency(v);
const ask = (left) => (
  <p className="text-sm text-stone-700">
    We need {left.join(", ")}.{" "}
    <Link href="/farm-data" className="font-medium text-emerald-800 underline">
      Add it in Farm data
    </Link>
  </p>
);
const failed = (r) => <p className="text-sm text-stone-600">{r.status === "error" ? `Not possible: ${r.error?.message}.` : `Missing ${r.missing?.map((m) => m.field).join(", ")}.`}</p>;
const neutral = "The engine works out both; which is better for you is a question for your accountant.";

/**
 * Decisions for a farmer in income averaging (ADR-0055): "Should I step out this year?" (tax.estimate with and without
 * step_out) and "What would leaving averaging cost?" (tax.averaging_exit). Both cases side by side, no recommendation.
 * `estimate`: this year's tax.estimate result (staying in averaging).
 */
export default function AveragingDecisions({ decisions, estimate, year }) {
  const { stepOut, exit, left } = decisions;
  const so = stepOut?.status === "ok" ? stepOut.result : null;
  const gap = so?.rules_applied.find((r) => r.rule_id === "averaging_step_out_gap_years")?.value;
  const x = exit?.status === "ok" ? exit.result : null;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card title="Should I step out this year?" subtitle={`Stepping out: ${year} taxed on its own profit instead of the 5-year average`} badge={<Badge>tax.estimate</Badge>}>
        {left.stepOut.length ? (
          ask(left.stepOut)
        ) : !so ? (
          failed(stepOut)
        ) : (
          <div className="space-y-3 text-sm text-stone-700">
            <table className="w-full">
              <thead className="text-left text-xs text-stone-500">
                <tr>
                  <th className="py-1 font-medium" />
                  <th className="py-1 text-right font-medium">Stay averaged</th>
                  <th className="py-1 text-right font-medium">Step out</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                <tr>
                  <td className="py-1">Profit taxed</td>
                  <td className="py-1 text-right">{eur(estimate.income.farm_profit)}</td>
                  <td className="py-1 text-right">{eur(so.income.farm_profit)}</td>
                </tr>
                <tr>
                  <td className="py-1">Income tax</td>
                  <td className="py-1 text-right">{eur(so.step_out.income_tax_on_average)}</td>
                  <td className="py-1 text-right">{eur(so.step_out.income_tax_on_actual)}</td>
                </tr>
                <tr className="border-t border-stone-200 font-semibold">
                  <td className="py-1">Total tax for {year}</td>
                  <td className="py-1 text-right">{eur(estimate.total_tax)}</td>
                  <td className="py-1 text-right">{eur(so.total_tax)}</td>
                </tr>
              </tbody>
            </table>
            {so.step_out.deferred_income_tax > 0 ? (
              <p>
                Stepping out puts off {eur(so.step_out.deferred_income_tax)} of income tax, paid in {so.step_out.instalments.length} parts:{" "}
                {so.step_out.instalments.map((i) => `${dayLabel(i.due)} ${i.due.slice(0, 4)}`).join(", ")} ({eur(so.step_out.instalments[0].amount)} each).
              </p>
            ) : (
              <p>Nothing is put off: this year’s own profit doesn’t give less income tax than the average.</p>
            )}
            <p className="text-xs text-stone-500">
              {gap ? `After a step-out, no other for ${gap} years. ` : ""}
              {neutral}
            </p>
          </div>
        )}
      </Card>

      <Card title="What would leaving averaging cost?" subtitle={`If ${year} is your last year in averaging`} badge={<Badge>tax.averaging_exit</Badge>}>
        {left.exit.length ? (
          ask(left.exit)
        ) : !x ? (
          failed(exit)
        ) : (
          <div className="space-y-3 text-sm text-stone-700">
            <p>
              Leaving tops up each of the 4 years before to at least {year}’s averaged profit of {eur(x.final_averaged_profit)}: <strong>{eur(x.total_additional_assessable)}</strong>{" "}
              more profit taxed in all.
            </p>
            <table className="w-full tabular-nums">
              <thead className="text-left text-xs text-stone-500">
                <tr>
                  <th className="py-1 font-medium">Year</th>
                  <th className="py-1 text-right font-medium">Taxed on</th>
                  <th className="py-1 text-right font-medium">Topped up to</th>
                  <th className="py-1 text-right font-medium">Extra profit taxed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {x.years.map((y) => (
                  <tr key={y.tax_year}>
                    <td className="py-1">{y.tax_year}</td>
                    <td className="py-1 text-right">{eur(y.assessed)}</td>
                    <td className="py-1 text-right">{eur(y.topped_up_to)}</td>
                    <td className="py-1 text-right">{eur(y.additional_assessable)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {x.deferred_step_out_tax_due_now > 0 && <p>Step-out tax still put off would be due at once: {eur(x.deferred_step_out_tax_due_now)}.</p>}
            <p className="text-xs text-stone-500">
              From {x.normal_basis_from} you’d be taxed on each year’s own profit. The tax on the extra profit depends on each year’s rates and your situation then: your
              accountant works it out. Whether to leave is a question for them too.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
