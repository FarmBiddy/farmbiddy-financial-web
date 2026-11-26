import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { formatCurrency } from "@/lib/format/currency";

const eur = (v) => formatCurrency(v);
const GROUP = { dairy_cows: "Dairy cows", heifers: "Heifers", calves: "Calves", weanlings: "Weanlings", stores: "Stores", stock_bulls: "Stock bulls" };
/** How Revenue practice values each group (herd.valuation `revenue_practice_basis`). */
const BASIS = {
  deemed_cost_pct: (g) => `${Math.round((g.unit_revenue_practice_value / g.unit_market_value) * 100)}% of market value`,
  held_value: () => "value held since they matured",
  written_down_to_market: () => "held value, written down to market",
};

/**
 * The herd at 31 December from herd.valuation (ADR-0055): each group on market value and on Revenue practice, side
 * by side. The Revenue-practice total is the herd value in your profit and tax; the market total is what a bank sees.
 * A held value the engine needs for mature stock is asked for in Farm data (needs_input path → group).
 */
export function HerdTable({ r }) {
  return (
    <div className="overflow-x-auto text-sm">
      <table className="w-full min-w-[34rem]">
        <thead className="text-left text-xs text-stone-500">
          <tr>
            <th className="py-1 font-medium">Group</th>
            <th className="py-1 text-right font-medium">Head</th>
            <th className="py-1 text-right font-medium">Market value</th>
            <th className="py-1 pl-3 text-right font-medium">Revenue practice</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 tabular-nums text-stone-700">
          {r.groups.map((g) => (
            <tr key={g.category}>
              <td className="py-1">{GROUP[g.category] ?? g.label ?? g.category}</td>
              <td className="py-1 text-right">{g.head}</td>
              <td className="py-1 text-right">{eur(g.market_value)}</td>
              <td className="py-1 pl-3 text-right">
                {eur(g.revenue_practice_value)}
                <span className="block text-[11px] text-stone-500">{BASIS[g.revenue_practice_basis]?.(g) ?? g.revenue_practice_basis}</span>
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-stone-300 font-semibold text-stone-900">
            <td className="py-1">Total</td>
            <td className="py-1 text-right">{r.total.head}</td>
            <td className="py-1 text-right">{eur(r.total.market_value)}</td>
            <td className="py-1 pl-3 text-right">{eur(r.total.revenue_practice_value)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-stone-500">
        Revenue practice values feed your profit and tax; a bank looks at market value. Revenue practice, not law: the 60% for young stock is how Revenue values
        them, your accountant may use other figures.
      </p>
    </div>
  );
}

/** `input`: the herd.valuation body sent, so "groups[1].unit_held_value" can be named "Stock bulls: value held". */
export default function HerdCard({ response, input, year }) {
  const name = ({ path = "", field }) => {
    const g = input?.groups?.[Number(path.match(/^groups\[(\d+)\]/)?.[1])];
    return `${GROUP[g?.category] ?? "a group"}: ${field === "unit_held_value" ? "value held a head" : field === "unit_market_value" ? "market value a head" : field}`;
  };
  const missing = response.status === "needs_input" ? response.missing.map(name) : null;
  return (
    <Card title={`Your herd at 31 December ${year}`} subtitle="On market value and on Revenue practice, side by side" badge={<Badge>herd.valuation</Badge>}>
      {response.status === "ok" ? (
        <HerdTable r={response.result} />
      ) : (
        <p className="text-sm text-stone-700">
          {missing
            ? `To value the herd we need: ${missing.join(", ")}.`
            : `Couldn’t value the herd: ${response.error?.message}.`}{" "}
          <Link href="/farm-data" className="font-medium text-emerald-800 underline">
            Add it in Farm data
          </Link>
        </p>
      )}
    </Card>
  );
}
