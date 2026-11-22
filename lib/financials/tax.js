import { assetsSchedule, plNet, taxCapitalAllowances, taxEstimate, taxStockRelief } from "@/lib/financial-engine/client";

/**
 * The farmer's tax for this calendar year (Ireland, engine ADR-0053 / ADR-0055), chained as the engine's integration
 * guide says: pl.net → tax.capital_allowances → tax.stock_relief → tax.estimate. The year is this year's 12 P&L months
 * as runFarm sent them (actual + forecast), with the flat-rate VAT addition already on them (vat.flat_rate, in
 * runFarm): it reaches taxable profit once, through pl.net. Needs `farm.tax` (the tax profile from Farm data).
 * Returns every step's response so the page can show how the figure was reached.
 *
 * Year-end valuations: what the farmer expects at 31 Dec (Farm data), else the latest the farm holds (balance
 * sheet at the last actual month), which the tax card says.
 * @param {{ thisYear: object } | null} fra  runFarm's vat.flat_rate calls (null for a VAT-registered farm)
 */
export async function runTax(farm, inputs, loans, fra = null) {
  const t = farm.tax;
  const months = inputs["pl.months"]?.months ?? [];
  if (taxQuestionsLeft(farm).length || months.length !== 12) return null;
  const year = farm.year;
  const bs = farm.balance_sheet ?? {};
  const values = {
    ...(bs.livestock_opening_value == null ? {} : { livestock_opening_value: bs.livestock_opening_value }),
    ...((t.year_end_livestock ?? bs.livestock) == null ? {} : { livestock_closing_value: t.year_end_livestock ?? bs.livestock }),
    ...(bs.stock_opening_value == null ? {} : { stock_opening_value: bs.stock_opening_value }),
    ...((t.year_end_stock ?? bs.stock) == null ? {} : { stock_closing_value: t.year_end_stock ?? bs.stock }),
  };
  const assets = (farm.assets ?? []).map(({ id, name, ...asset }) => asset);
  const ok = (r) => (r?.status === "ok" ? r.result : null);
  const vat = fra?.thisYear ?? null;

  const schedule = assets.length ? await assetsSchedule({ assets, from_year: year, from_month: 1, to_year: year, to_month: 12 }) : null;
  const depreciation = ok(schedule)?.total.depreciation ?? 0;
  // ponytail: pl.net takes the year's interest, not the loans, so the 12 months of loan.schedule interest are added
  // up here; drop this sum if pl.net accepts loans.
  const interest = (loans?.months ?? []).filter((m) => m.period.year === year).reduce((s, m) => s + m.interest, 0);
  const net = await plNet({ months, depreciation, interest: Math.round(interest * 100) / 100, ...values });
  if (!ok(net)) return { net, vat };

  // No assets: tax.capital_allowances needs one, so the guide's stand-in (pl.net profit) is the trading profit.
  const allowances = assets.length
    ? await taxCapitalAllowances({
        tax_year: year,
        period_end_month: 12,
        assets: taxAssets(farm),
        accounting_profit: net.result.net_profit_before_tax,
        depreciation,
      })
    : null;
  const trading = ok(allowances)?.profit_bridge.taxable_profit ?? net.result.net_profit_before_tax;

  const relief = await taxStockRelief({
    business_type: t.business_type,
    period_end_year: year,
    period_end_month: 12,
    trading_profit: trading,
    ...values,
    ...(t.young_trained_farmer_first_year ? { young_trained_farmer_first_year: t.young_trained_farmer_first_year } : {}),
  });
  if (!ok(relief)) return { net, vat, allowances, relief };

  const estimate = await taxEstimate({
    business_type: t.business_type,
    tax_year: year,
    taxable_profit: relief.result.profit_after_relief,
    stock_relief: relief.result.relief,
    stock_relief_regime: relief.result.regime,
    // a company pays corporation tax: the household fields are for individuals only. Only what the farmer
    // answered is sent (taxQuestionsLeft makes sure the ones that matter are answered).
    ...(t.business_type === "company"
      ? {}
      : { ...personalTaxInputs(farm), ...estimateExtras(farm), ...averagingInputs(farm, ok(allowances)?.total.allowance ?? 0) }),
  });
  return { net, vat, allowances, relief, estimate, assetsUsed: assets.length > 0 };
}

/** tax.estimate's household fields for a person, from the farmer's answers (nothing assumed). */
function personalTaxInputs(farm) {
  const t = farm.tax;
  return {
    marital_status: t.marital_status,
    ...(t.marital_status === "married" ? { spouse_paye_income: t.spouse_paye_income } : {}),
    ...(farm.household?.off_farm_income_per_year == null ? {} : { other_income: farm.household.off_farm_income_per_year }),
  };
}

/**
 * tax.estimate inputs for a person beyond the plan's profile (ADR-0055), each only when the farmer answered it: losses
 * brought forward, pension contributions with the year of birth, and for a married couple the home carer credit and
 * the spouse's own business profit and farm wages (a sole trader's).
 */
export function estimateExtras(farm) {
  const t = farm.tax;
  const married = t.marital_status === "married";
  const given = (key) => (t[key] == null ? {} : { [key]: t[key] });
  return {
    ...given("losses_forward"),
    ...given("pension_contributions"),
    ...given("birth_year"),
    ...(married && t.home_carer ? { home_carer: t.home_carer === "yes" } : {}),
    ...(married ? given("spouse_self_employed_income") : {}),
    ...(married && t.business_type === "sole_trader" ? given("spouse_farm_wages") : {}),
  };
}

/**
 * Income averaging (s.657): the farmer's answer always goes (the engine asks for it), and with averaging the previous
 * 4 years' profits and this year's capital allowances (the amount already in taxable_profit).
 */
function averagingInputs(farm, capitalAllowances) {
  if (farm.tax.income_averaging !== "elected") return { income_averaging: false };
  return { income_averaging: true, prior_farming_profits: priorProfits(farm), capital_allowances: capitalAllowances };
}

/** The 4 years before this one whose farming profit averaging needs. */
export const averagingYears = (farm) => [4, 3, 2, 1].map((n) => farm.year - n);

/** Profit before capital allowances for each of the 4 years before this one, oldest first; null if any is missing. */
export function priorProfits(farm) {
  const profits = averagingYears(farm).map((y) => farm.tax?.prior_profit?.[y]);
  return profits.every((p) => p != null) ? profits : null;
}

/**
 * The tax questions the farmer still has to answer before an estimate means anything (no defaults are assumed):
 * how the farm is set up and VAT always; for a person, married or not (if married, the spouse's wages: 0 counts) and
 * whether they're in income averaging (if so, the last 4 years' profits).
 */
export function taxQuestionsLeft(farm) {
  const t = farm.tax ?? {};
  const left = [];
  if (!t.business_type) left.push("how the farm is set up");
  if (!t.vat) left.push("VAT");
  if (t.business_type !== "company") {
    if (!t.marital_status) left.push("married or not");
    else if (t.marital_status === "married" && t.spouse_paye_income == null) left.push("your spouse’s wages");
    // the age sets how much pension relief there can be: the engine needs the year of birth with contributions
    if (t.pension_contributions > 0 && t.birth_year == null) left.push("your year of birth (for pension relief)");
    if (!t.income_averaging) left.push("income averaging");
    else if (t.income_averaging === "elected" && !priorProfits(farm)) left.push(`your profit for each year ${averagingYears(farm)[0]}–${farm.year - 1}`);
  }
  return left;
}

/**
 * The household tax a lender should see, with whose figure it is (debt.capacity / report.* need both, ADR-0055):
 * the accountant's figure when given, else the engine's estimate.
 * @returns {{ amount: number, source: "accountant" | "estimate" } | null}
 */
export function householdTax(farm, tax) {
  if (farm.household?.tax_per_year != null) return { amount: farm.household.tax_per_year, source: "accountant" };
  return tax?.estimate?.status === "ok" ? { amount: tax.estimate.result.total_tax, source: "estimate" } : null;
}

/**
 * Preliminary tax questions still open for tax.payments (individuals; a company's corporation tax dates are not in the
 * engine yet): the basis, direct debit (and its first month), last year's tax and the preliminary paid for it, and for
 * the 105% basis the year before's tax.
 */
export function taxPaymentQuestionsLeft(farm) {
  const t = farm.tax ?? {};
  const [before, last] = [farm.year - 2, farm.year - 1];
  const left = [];
  if (!t.preliminary_basis) left.push("how you work out preliminary tax");
  if (!t.direct_debit) left.push("whether you pay by direct debit");
  else if (t.direct_debit === "yes" && t.direct_debit_start_month == null) left.push("the month your direct debit starts");
  if (t.past_tax?.[last] == null) left.push(`your ${last} tax`);
  if (t.past_prelim?.[last] == null) left.push(`the preliminary tax you paid for ${last}`);
  if (t.preliminary_basis === "pre_preceding_105_dd" && t.past_tax?.[before] == null) left.push(`your ${before} tax`);
  return left;
}

/**
 * tax.payments input (ADR-0055): this autumn's bill, last year's balance + this year's preliminary, from this year's
 * tax (the accountant's figure or the estimate) and the farmer's answers. null when it can't be asked yet.
 * @param {{ amount: number, source: string } | null} thisYear  householdTax
 */
export function buildTaxPaymentsInput(farm, thisYear) {
  const t = farm.tax ?? {};
  if (!t.business_type || t.business_type === "company" || !thisYear || taxPaymentQuestionsLeft(farm).length) return null;
  const [before, last] = [farm.year - 2, farm.year - 1];
  const dd = t.direct_debit === "yes";
  return {
    tax_year: farm.year,
    current_year_tax: thisYear.amount,
    preceding_year_tax: t.past_tax[last],
    preceding_year_preliminary_paid: t.past_prelim[last],
    ...(t.past_tax?.[before] == null ? {} : { pre_preceding_year_tax: t.past_tax[before] }),
    preliminary_basis: t.preliminary_basis,
    ...(dd ? { direct_debit: true, direct_debit_start_month: t.direct_debit_start_month } : {}),
  };
}

/** The month the bill is paid: the ROS date when Revenue announced one (accountants file on ROS), else 31 October. */
export const payDate = (p) => p.pay_date.ros ?? p.pay_date.statutory;

/**
 * What tax.payments says goes out of the bank in each month still to come (the cash forecast never projects it):
 * the amount due on the pay date, and by direct debit each instalment in its month. Months already past are records.
 * @returns {Map<number, number>} calendar month → amount
 */
export function taxPaymentsByMonth(farm, payments) {
  const out = new Map();
  if (payments?.status !== "ok") return out;
  const p = payments.result;
  const add = (year, month, amount) => {
    if (year === farm.year && month > farm.actual_through_month && amount > 0) out.set(month, (out.get(month) ?? 0) + amount);
  };
  const [y, m] = payDate(p).split("-").map(Number);
  add(y, m, p.due_on_pay_date);
  for (const i of p.direct_debit_instalments ?? []) add(i.year, i.month, i.amount);
  return out;
}

/** The plan's tax history questions still open (plan.projection, individuals): how preliminary tax is paid, last year's tax and what was paid for it. */
export function planTaxQuestionsLeft(farm) {
  const t = farm.tax ?? {};
  if (t.business_type === "company") return [];
  const last = farm.year - 1;
  const left = [];
  if (!["current_90", "prior_100"].includes(t.preliminary_basis)) left.push("how you pay preliminary tax (90% of this year or 100% of last year)");
  if (t.past_tax?.[last] == null) left.push(`your ${last} tax`);
  if (t.past_prelim?.[last] == null) left.push(`the preliminary tax you paid for ${last}`);
  return left;
}

/**
 * The tax profile for plan.projection (ADR-0053 / ADR-0055: per-year tax instead of a fixed assumptions.tax), from the
 * farmer's answers only: null until taxQuestionsLeft and planTaxQuestionsLeft are empty. With averaging, the 4 years'
 * profits. A person's plan also pays tax on the Irish dates, so it needs how preliminary tax is paid and the tax
 * history the first October needs: last year's tax and preliminary, and this year's tax (paid inside the plan).
 * @param {number | null} thisYearTax  this year's tax: the accountant's figure or the engine's estimate
 */
export function planTaxProfile(farm, thisYearTax = null) {
  const t = farm.tax;
  if (!t || taxQuestionsLeft(farm).length) return null;
  const individual = t.business_type !== "company";
  if (individual && (planTaxQuestionsLeft(farm).length || thisYearTax == null)) return null;
  const elected = t.income_averaging === "elected";
  const last = farm.year - 1;
  return {
    business_type: t.business_type,
    vat_registered: t.vat === "registered",
    ...(individual
      ? {
          ...personalTaxInputs(farm),
          ...(t.young_trained_farmer_first_year ? { young_trained_farmer_first_year: t.young_trained_farmer_first_year } : {}),
          income_averaging: elected,
          ...(elected ? { prior_farming_profits: priorProfits(farm) } : {}),
          preliminary_basis: t.preliminary_basis,
          // ponytail: the years a calendar-year farm needs when its last actual month is before October (the engine
          // names them otherwise: tax_history_invalid shows on the Plan page).
          tax_history: [
            { tax_year: last, liability: t.past_tax[last], preliminary_paid: t.past_prelim[last] },
            { tax_year: farm.year, liability: thisYearTax },
          ],
        }
      : {}),
  };
}

/** The asset register with each asset's grant and allowance type (for tax), ids and names left on the platform. */
export const taxAssets = (farm) =>
  (farm.assets ?? []).map(({ id, name, ...asset }) => ({
    ...asset,
    ...(farm.tax?.grant?.[id] ? { grant: farm.tax.grant[id] } : {}),
    ...(farm.tax?.allowance?.[id] ? { tax_allowance: farm.tax.allowance[id] } : {}),
  }));
