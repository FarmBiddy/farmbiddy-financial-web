import Link from "next/link";
import { Card } from "@/components/ui";
import AutoSaveForm from "@/components/AutoSaveForm";
import AccountsUpload from "@/components/AccountsUpload";
import { canEdit, loadFarm, readEdits, yearValue } from "@/lib/farm-edits";
import { HERD_GROUPS, MATURE_GROUPS } from "@/lib/farm-edits-core";
import { averagingYears } from "@/lib/financials/tax";
import { CENTS, CHEQUE, FIELD_GROUPS, NEEDED, hasRecords, ownFigure } from "@/lib/farm-fields";
import { ADVISOR, getViewer } from "@/lib/session";
import { forecastMilkPrice } from "@/lib/financials/farm";
import { monthLabel } from "@/lib/format/date";
import { autosaveFarmData, resetFarmData } from "./actions";

export const metadata = { title: "Farm data · FarmBiddy" };

const pill = (on) =>
  `rounded-full px-3 py-1 text-sm ring-1 ${on ? "bg-emerald-800 text-white ring-emerald-800" : "bg-white text-stone-700 ring-stone-300 hover:bg-stone-50"}`;
const chip = (tone, text) => <span className={`rounded-full px-1.5 text-[10px] font-medium ${tone}`}>{text}</span>;

/**
 * One number. `locked`: why this viewer can't change it, shown instead of the hint.
 * `signed`: takes negatives (no min). `cents`: typed in c/litre, saved in €/litre (the "c:" name prefix).
 */
function Field({ name, label, unit, step = "1", value, edited, hint, optional, min = "0", signed, locked, cents }) {
  // the farm-file path behind the input name ("c:year.pl.milk_price" → "pl.milk_price"), to see if the engine needs it
  const needed = NEEDED[name.replace(/^c:/, "").replace(/^(year|months\.\d+)\./, "").replace(/_pct$/, "")];
  return (
    <label className="block text-sm">
      <span className="flex flex-wrap items-center gap-x-2 text-stone-700">
        <span>
          {label}
          {needed && (
            <span className="ml-0.5 font-semibold text-red-600" title={`Needed for ${needed}`}>
              *<span className="sr-only"> (needed for {needed})</span>
            </span>
          )}
        </span>{" "}
        <span className="text-xs text-stone-400">{unit}</span>
        {edited && chip("bg-amber-100 text-amber-800", "edited")}
      </span>
      <input
        name={cents ? `c:${name}` : name}
        data-label={label}
        type="number"
        step={cents ? "0.01" : step}
        min={signed ? undefined : min}
        required={!optional && value != null && value !== ""}
        disabled={!!locked}
        defaultValue={value ?? ""}
        className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 tabular-nums invalid:border-red-400 disabled:bg-stone-100 disabled:text-stone-500"
      />
      {(locked || hint) && <span className="mt-0.5 block text-xs text-stone-500">{locked ? `🔒 ${locked}` : hint}</span>}
    </label>
  );
}

/** A pick from a short list (tax profile), saved as it changes. */
function Choice({ name, label, value, options, edited, locked, hint }) {
  return (
    <label className="block text-sm">
      <span className="flex flex-wrap items-center gap-x-2 text-stone-700">
        {label}
        {edited && chip("bg-amber-100 text-amber-800", "edited")}
      </span>
      <select
        key={value ?? "none"} // a new stored value redraws it, or the browser keeps showing the old pick
        name={name}
        data-label={label}
        data-saved={value ?? ""}
        defaultValue={value ?? ""}
        disabled={!!locked}
        className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 disabled:bg-stone-100"
      >
        {value == null && <option value="">Choose…</option>}
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      {(locked || hint) && <span className="mt-0.5 block text-xs text-stone-500">{locked ? `🔒 ${locked}` : hint}</span>}
    </label>
  );
}

/** One number in a table (past years, herd groups): labelled for screen readers and the validation message. */
function Cell({ name, label, value, edited, locked, signed, step = "1" }) {
  return (
    <td className="py-1 pr-2">
      <input
        name={name}
        aria-label={label}
        data-label={label}
        type="number"
        step={step}
        min={signed ? undefined : "0"}
        disabled={!!locked}
        defaultValue={value ?? ""}
        className={`w-full min-w-24 rounded-lg border bg-white px-2 py-1.5 tabular-nums invalid:border-red-400 disabled:bg-stone-100 ${edited ? "border-amber-400" : "border-stone-300"}`}
      />
    </td>
  );
}

const sub = (text) => <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-stone-500 first:mt-0">{text}</p>;
const YES_NO = [["yes", "Yes"], ["no", "No"]];
const monthName = (m) => new Intl.DateTimeFormat("en-IE", { month: "long", timeZone: "UTC" }).format(Date.UTC(2000, m - 1));
const HERD_LABELS = { dairy_cows: "Dairy cows", heifers: "Heifers (in calf and replacements)", calves: "Calves", weanlings: "Weanlings", stores: "Stores", stock_bulls: "Stock bulls" };

/**
 * Edit the numbers the platform holds for the farm. Saving sends nothing to the engine directly:
 * every page re-runs the engine with the new numbers.
 */
export default async function FarmDataPage({ searchParams }) {
  const { m, v, saved, reset } = await searchParams;
  const byMonth = v === "months";
  const farm = await loadFarm();
  const farmId = farm.profile.id;
  const edits = await readEdits(farmId);
  const { role } = await getViewer();
  const hasAdvisor = ADVISOR.clients.includes(farmId);
  const lock = (path) => (canEdit(role, farmId, path) ? null : role === "owner" ? `Set by ${ADVISOR.name}, your advisor` : `${farm.profile.name}'s record`);
  const ownEdits = Object.keys(edits).filter((p) => canEdit(role, farmId, p)).length;
  const starter = Boolean(farm.profile.starter);
  const actualMonths = farm.months.map((x) => x.month);
  const month = actualMonths.includes(Number(m)) ? Number(m) : farm.actual_through_month;
  const record = farm.months.find((x) => x.month === month);
  const valueOf = (path) => path.split(".").reduce((o, k) => o?.[k], record);
  const firstForecast = farm.actual_through_month + 1;
  // A new farmer's fields start empty, not at 0: nothing has been entered yet.
  const show = (path, v) => (starter && !ownFigure(edits, path) ? "" : v == null ? 0 : CENTS.has(path) ? +(v * 100).toFixed(2) : Math.round(v));
  const fresh = starter && !hasRecords(farm);
  const loanTerms = farm.new_loan_terms ?? {};
  // Tax answers (engine 1.11.0 asks these; nothing is defaulted, an empty field means the card says what's missing)
  const t = farm.tax ?? {};
  const person = t.business_type !== "company";
  const married = t.marital_status === "married";
  const averaging = t.income_averaging === "elected";
  const taxField = (key) => ({ name: `tax.${key}`, value: t[key], edited: `tax.${key}` in edits, locked: lock(`tax.${key}`), optional: true });
  const pastYears = averagingYears(farm); // the 4 years before this one
  const last = (n) => pastYears.slice(-n);
  // [key under tax, label, years asked, help, signed]
  const pastRows = [
    ...(person && averaging
      ? [
          ["prior_profit", "Farming profit", pastYears, "Before capital allowances, after stock relief: what averaging uses", true],
          ["assessed_profit", "Profit you were taxed on", pastYears, "Before allowances. Only for “leaving averaging” in Decisions", true],
        ]
      : []),
    ["past_tax", "Your tax for the year", last(3), "Income tax, USC and PRSI on your return"],
    ...(person ? [["past_prelim", "Preliminary tax paid for the year", last(2), "What you paid in advance, the autumn before"]] : []),
    ["filed_net_profit", "Net profit in your accounts", last(3), "Banks read your last 3 years of accounts", true],
    ["filed_depreciation", "Depreciation in your accounts", last(3)],
    ["filed_interest", "Loan interest in your accounts", last(3)],
  ];
  const herd = farm.herd ?? {};
  const yearEnd = farm.year_end ?? {};
  const forecastPrice = forecastMilkPrice(farm, firstForecast);
  const settings = (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field
        name="market.milk_price"
        label={`Milk price, ${monthLabel(firstForecast)}–Dec`}
        unit="c/litre"
        cents
        value={+(forecastPrice * 100).toFixed(2)}
        edited={"market.milk_price" in edits}
        locked={lock("market.milk_price")}
        hint="What you expect the co-op to pay for the rest of the year"
      />
      <Field
        name="new_loan_terms.annual_rate_pct"
        label="New loan: interest rate"
        unit="% a year"
        step="0.01"
        value={loanTerms.annual_rate == null ? null : +(loanTerms.annual_rate * 100).toFixed(4)}
        edited={"new_loan_terms.annual_rate" in edits}
        locked={lock("new_loan_terms.annual_rate")}
      />
      <Field name="new_loan_terms.term_months" label="New loan: term" unit="months" value={loanTerms.term_months} edited={"new_loan_terms.term_months" in edits} locked={lock("new_loan_terms.term_months")} />
      <Field
        name="new_loan_terms.min_cover"
        label="Lender’s minimum cover"
        unit="×"
        step="0.01"
        min="1"
        value={loanTerms.min_cover}
        edited={"new_loan_terms.min_cover" in edits}
        locked={lock("new_loan_terms.min_cover")}
        hint="How many times over the bank wants repayments covered"
      />
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Farm data</h1>
          <p className="text-sm text-stone-500">
            The numbers FarmBiddy holds for {farm.profile.farm_name}. Every change is recalculated on every page, report and Biddy answer.
          </p>
          <p className="mt-1 text-sm text-stone-600">
            <span className="font-semibold text-red-600">*</span> Needed before FarmBiddy can work out your figures. Everything else can wait.
          </p>
        </div>
        {ownEdits > 0 && (
          <form action={resetFarmData}>
            <button className="rounded-lg px-3 py-1.5 text-sm text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50">
              {starter ? "Start again" : "Reset to demo data"}
            </button>
          </form>
        )}
      </div>

      {starter && role === "owner" && (
        <div className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-950 ring-1 ring-sky-200">
          <p className="font-medium">Welcome, {farm.profile.name.split(" ")[0]}.</p>
          <p className="mt-1">
            {fresh
              ? "Nothing’s been added yet. Start with your cows and bank balance, then your year totals, milk first. Every page fills in as you go."
              : farm.opening_cash == null
                ? "Add your bank balance on 1 January to see your cash flow."
                : "Keep going: every figure you add sharpens your numbers."}
          </p>
        </div>
      )}

      {(saved || reset) && (
        <p role="status" className="rounded-xl bg-emerald-50 px-4 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          {saved ? "Saved. " : starter ? "Back to the starter figures. " : "Back to the demo data. "}
          <Link href="/farm-financials" className="font-medium underline">
            See Farm Financials
          </Link>{" "}
          or the{" "}
          <Link href="/dashboard" className="font-medium underline">
            Dashboard
          </Link>
          .
        </p>
      )}

      {role === "owner" && <AccountsUpload key={`${farm.tax?.last_year ?? "none"}:${reset ?? ""}`} imported={farm.tax?.last_year} />}

      {/* key: remount on a new view, month or reset so the uncontrolled inputs show the stored values */}
      <AutoSaveForm key={`${byMonth ? month : "year"}:${reset ?? ""}:${farm.tax?.last_year ?? ""}`} action={autosaveFarmData} className="space-y-6">
        <input type="hidden" name="_month" value={month} />

        <Card title="Farm" subtitle="Leave a field empty if you don’t know it: Biddy will ask for it.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field name="milking_cows" label="Milking cows" unit="cows" value={farm.milking_cows} edited={"milking_cows" in edits} optional locked={lock("milking_cows")} />
            <Field name="hectares" label="Farmed area" unit="hectares" step="0.1" value={farm.hectares} edited={"hectares" in edits} locked={lock("hectares")} />
            <Field
              name="opening_cash"
              label={`Bank balance on 1 Jan ${farm.year}`}
              unit="€ (minus = overdraft)"
              value={farm.opening_cash}
              edited={"opening_cash" in edits}
              locked={lock("opening_cash")}
              optional
              signed
              hint={farm.opening_cash == null ? "Needed for your cash flow: from your 1 January bank statement" : "From your 1 January bank statement"}
            />
          </div>
        </Card>

        <Card
          title="Your year so far"
          subtitle={`${monthLabel(1)}–${monthLabel(farm.actual_through_month)} ${farm.year}: what actually happened, from co-op statements, bank and invoices.`}
        >
          <nav aria-label="View" className="mb-4 flex flex-wrap gap-1.5">
            {[
              ["Year totals", "/farm-data", !byMonth],
              ["Month by month", `/farm-data?v=months&m=${month}`, byMonth],
            ].map(([label, href, on]) => (
              <Link key={label} href={href} aria-current={on ? "page" : undefined} className={pill(on)}>
                {label}
              </Link>
            ))}
          </nav>
          {byMonth && (
            <nav aria-label="Month" className="mb-4 flex flex-wrap gap-1.5">
              {actualMonths.map((x) => (
                <Link key={x} href={`/farm-data?v=months&m=${x}`} aria-current={x === month ? "page" : undefined} className={pill(x === month)}>
                  {monthLabel(x)}
                  {Object.keys(edits).some((p) => p.startsWith(`months.${x}.`)) ? " •" : ""}
                </Link>
              ))}
            </nav>
          )}
          <div className="space-y-6">
            {FIELD_GROUPS.map((group) => (
              <fieldset key={group.title}>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">{group.title}</legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  {group.fields.map(([path, label, unit, hint]) => {
                    const own = ownFigure(edits, path);
                    return byMonth ? (
                      <Field
                        key={path}
                        name={`months.${month}.${path}`}
                        label={label}
                        unit={unit}
                        cents={CENTS.has(path)}
                        value={show(path, valueOf(path))}
                        edited={`months.${month}.${path}` in edits || `months_scale.${path}` in edits}
                        locked={lock(`months.${month}.${path}`)}
                        hint={hint}
                      />
                    ) : (
                      <Field
                        key={path}
                        name={`year.${path}`}
                        label={CENTS.has(path) ? `Average ${label.toLowerCase()}` : label}
                        unit={unit}
                        cents={CENTS.has(path)}
                        value={show(path, yearValue(farm, path))}
                        edited={!starter && own}
                        locked={lock(`months_scale.${path}`)}
                        hint={hint}
                      />
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <details className="rounded-lg bg-stone-50 px-3 py-2 text-sm" open={ownFigure(edits, CHEQUE[0]) || undefined}>
              <summary className="cursor-pointer text-stone-700">
                Milk cheques: worked out from litres × price, paid the month after.{" "}
                <span className="text-emerald-800 underline">Different on your bank statement?</span>
              </summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <Field
                  name={byMonth ? `months.${month}.${CHEQUE[0]}` : `year.${CHEQUE[0]}`}
                  label={CHEQUE[1]}
                  unit={CHEQUE[2]}
                  value={show(CHEQUE[0], byMonth ? valueOf(CHEQUE[0]) : yearValue(farm, CHEQUE[0]))}
                  edited={ownFigure(edits, CHEQUE[0])}
                  locked={lock(`months_scale.${CHEQUE[0]}`)}
                  hint={CHEQUE[3]}
                />
              </div>
            </details>
          </div>
          <p className="mt-4 text-xs text-stone-500">
            {byMonth
              ? "A month you change here stays as you typed it, even if you change the year total later."
              : "One figure for the year is enough. Change a total and we spread it over the months the way your figures already run (more feed in winter, more fertiliser in spring). Know a month exactly? Use Month by month."}
          </p>
        </Card>

        <Card title="Tax" subtitle="For your tax estimate, the tax due this autumn and the Plan. A figure from your accountant always wins.">
          {sub("You and your household")}
          <div className="grid gap-4 sm:grid-cols-3">
            <Choice
              name="tax.business_type"
              label="How the farm is set up"
              value={farm.tax?.business_type}
              options={[["sole_trader", "Sole trader (just me)"], ["company", "Limited company"]]}
              edited={"tax.business_type" in edits}
              locked={lock("tax.business_type")}
              hint="Partnerships come later"
            />
            <Choice
              name="tax.marital_status"
              label="Married or civil partners?"
              value={farm.tax?.marital_status}
              options={[["single", "No"], ["married", "Yes"]]}
              edited={"tax.marital_status" in edits}
              locked={lock("tax.marital_status")}
            />
            <Field
              name="tax.spouse_paye_income"
              label="Your spouse’s wages"
              unit="€ a year"
              value={farm.tax?.spouse_paye_income}
              optional
              edited={"tax.spouse_paye_income" in edits}
              locked={lock("tax.spouse_paye_income")}
              hint="Only if married: wages from a job off the farm, before tax. Enter 0 if none"
            />
            <Choice
              name="tax.vat"
              label="VAT"
              value={farm.tax?.vat}
              options={[["flat_rate", "Not registered (flat-rate farmer)"], ["registered", "Registered for VAT"]]}
              edited={"tax.vat" in edits}
              locked={lock("tax.vat")}
              hint="Most dairy farmers aren’t registered"
            />
            <Field
              name="tax.young_trained_farmer_first_year"
              label="Young trained farmer relief: first year"
              unit="year"
              min="2000"
              value={farm.tax?.young_trained_farmer_first_year}
              optional
              edited={"tax.young_trained_farmer_first_year" in edits}
              locked={lock("tax.young_trained_farmer_first_year")}
              hint="Leave empty if you don’t have it"
            />
            {person && (
              <>
                {married && (
                  <>
                    <Field {...taxField("spouse_self_employed_income")} label="Your spouse’s own business profit" unit="€ a year" hint="If your spouse has a business of their own: its profit. Enter 0 if none" />
                    {t.business_type === "sole_trader" && (
                      <Field {...taxField("spouse_farm_wages")} label="Wages the farm pays your spouse" unit="€ a year" hint="Enter 0 if the farm pays your spouse no wages" />
                    )}
                    <Choice
                      {...taxField("home_carer")}
                      label="Does your spouse care for someone at home?"
                      options={YES_NO}
                      hint="A child, an older person or someone with a disability, full time at home. For the home carer credit"
                    />
                  </>
                )}
                <Field {...taxField("birth_year")} label="Your year of birth" unit="year" min="1920" hint="Sets how much pension relief you can get" />
                <Field {...taxField("pension_contributions")} label={`Pension contributions in ${farm.year}`} unit="€" hint="What you pay into your own pension this year. Enter 0 if none" />
                <Field {...taxField("losses_forward")} label="Farm losses carried forward" unit="€" hint="Losses from earlier years not used yet: your last tax computation shows them. Enter 0 if none" />
              </>
            )}
          </div>

          {person && (
            <>
              {sub("Income averaging")}
              <div className="grid gap-4 sm:grid-cols-3">
                <Choice
                  {...taxField("income_averaging")}
                  label="Are you in income averaging?"
                  options={[["elected", "Yes"], ["not_elected", "No"]]}
                  hint="Tax on your average profit over 5 years. Most dairy farmers are: your accounts or accountant will say"
                />
                {averaging && (
                  <Choice
                    {...taxField("last_step_out_year")}
                    label="The last year you stepped out"
                    options={[["never", "Never"], ...Array.from({ length: 12 }, (_, i) => farm.year - 1 - i).map((y) => [String(y), String(y)])]}
                    hint="Stepping out: one year taxed on its own profit. Allowed once every 5 years"
                  />
                )}
              </div>

              {sub("Preliminary tax (paid every autumn)")}
              <div className="grid gap-4 sm:grid-cols-3">
                <Choice
                  {...taxField("preliminary_basis")}
                  label="How you work out preliminary tax"
                  options={[
                    ["current_90", "90% of this year’s tax"],
                    ["prior_100", "100% of last year’s tax"],
                    ["pre_preceding_105_dd", "105% of the year before last (direct debit only)"],
                  ]}
                  hint="Your accountant picks one. The tax due card shows all three"
                />
                <Choice {...taxField("direct_debit")} label="Do you pay it by monthly direct debit?" options={YES_NO} />
                {t.direct_debit === "yes" && (
                  <Choice
                    {...taxField("direct_debit_start_month")}
                    label="Direct debit starts in"
                    options={Array.from({ length: 12 }, (_, i) => [String(i + 1), monthName(i + 1)])}
                    hint={`The first month of ${farm.year} the direct debit is taken`}
                  />
                )}
              </div>
            </>
          )}

          {sub("Your last few years")}
          <p className="-mt-1 mb-2 text-xs text-stone-500">From your accounts and tax returns. Upload last year’s accounts above to fill in what we can read.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-stone-500">
                <tr>
                  <th className="py-1 pr-2 font-medium" />
                  {pastYears.map((y) => (
                    <th key={y} className="py-1 pr-2 font-medium">
                      {y}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pastRows.map(([key, label, years, hint, signed]) => (
                  <tr key={key}>
                    <th scope="row" className="py-1 pr-3 text-left align-middle font-normal text-stone-700">
                      {label}
                      {hint && <span className="block text-xs text-stone-500">{hint}</span>}
                    </th>
                    {pastYears.map((y) =>
                      years.includes(y) ? (
                        <Cell
                          key={y}
                          name={`tax.${key}.${y}`}
                          label={`${label}, ${y}`}
                          value={t[key]?.[y]}
                          edited={`tax.${key}.${y}` in edits}
                          locked={lock(`tax.${key}.${y}`)}
                          signed={signed}
                        />
                      ) : (
                        <td key={y} className="py-1 pr-2 text-center text-stone-300">
                          —
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sub("This year")}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              name="tax.year_end_stock"
              label={`Feed, fertiliser and fuel in stock at 31 Dec ${farm.year}`}
              unit="€"
              value={farm.tax?.year_end_stock}
              optional
              edited={"tax.year_end_stock" in edits}
              locked={lock("tax.year_end_stock")}
              hint={farm.balance_sheet?.stock != null ? `Leave empty to use your latest value (€${farm.balance_sheet.stock.toLocaleString("en-IE")})` : "For stock relief"}
            />
            <Field
              name="household.tax_per_year"
              label="Tax figure from your accountant"
              unit="€ a year"
              value={farm.household?.tax_per_year}
              optional
              edited={"household.tax_per_year" in edits}
              locked={lock("household.tax_per_year")}
              hint="Leave empty to use our estimate"
            />
          </div>
        </Card>

        <Card title="Year end" subtitle={`What the farm will have and owe at 31 December ${farm.year}. For your herd value, your tax and why cash differs from profit.`}>
          {sub(`Your herd at 31 Dec ${farm.year}`)}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs text-stone-500">
                <tr>
                  <th className="py-1 pr-2 font-medium" />
                  <th className="py-1 pr-2 font-medium">Head</th>
                  <th className="py-1 pr-2 font-medium">Market value, € a head</th>
                  <th className="py-1 pr-2 font-medium">
                    Value held, € a head
                    <span className="block font-normal">Cows and bulls only: your accountant’s figure from last year’s accounts</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {HERD_GROUPS.map((g) => (
                  <tr key={g}>
                    <th scope="row" className="py-1 pr-3 text-left font-normal text-stone-700">
                      {HERD_LABELS[g]}
                    </th>
                    {["head", "market", ...(MATURE_GROUPS.includes(g) ? ["held"] : [])].map((f) => (
                      <Cell
                        key={f}
                        name={`herd.${g}.${f}`}
                        label={`${HERD_LABELS[g]}: ${{ head: "head", market: "market value a head", held: "value held a head" }[f]}`}
                        value={herd[g]?.[f]}
                        edited={`herd.${g}.${f}` in edits}
                        locked={lock(`herd.${g}.${f}`)}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-stone-500">Head counts from your ICBF herd profile or a stock take; market values from the mart or your accountant. Leave a group empty if you have none.</p>

          {sub("Money owed, at the start and end of the year")}
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["milk_owed_start", `Milk money owed to you on 1 Jan ${farm.year}`, "The co-op’s cheque for December’s milk, paid in January"],
              ["milk_owed_end", `Milk money owed to you at 31 Dec ${farm.year}`, "What the January cheque will pay for December’s milk"],
              ["merchant_credit_start", `You owed merchants and the co-op on 1 Jan ${farm.year}`, "Feed, fertiliser and other bills not yet paid"],
              ["merchant_credit_end", `You expect to owe them at 31 Dec ${farm.year}`, "Your merchant and co-op statements"],
            ].map(([key, label, hint]) => (
              <Field
                key={key}
                name={`year_end.${key}`}
                label={label}
                unit="€"
                value={yearEnd[key]}
                optional
                edited={`year_end.${key}` in edits}
                locked={lock(`year_end.${key}`)}
                hint={hint}
              />
            ))}
          </div>
        </Card>

        {role === "owner" ? (
          <details className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone-200/70">
            <summary className="cursor-pointer text-sm">
              <span className="font-semibold">Forecast settings</span>
              <span className="text-stone-500">
                {" "}
                · milk {(forecastPrice * 100).toFixed(1)}c/litre for {monthLabel(firstForecast)}–Dec
                {loanTerms.annual_rate != null && ` · new loan ${(loanTerms.annual_rate * 100).toFixed(1)}% over ${loanTerms.term_months / 12} years`}
                {hasAdvisor ? ` · set by ${ADVISOR.name}, your advisor` : " · change them if you know better"}
              </span>
            </summary>
            <div className="mt-4">{settings}</div>
          </details>
        ) : (
          <Card title="Forecast settings" subtitle="Your assumptions for this client: the rest of the year’s milk price and the terms for a new loan.">
            {settings}
          </Card>
        )}
      </AutoSaveForm>
    </div>
  );
}
