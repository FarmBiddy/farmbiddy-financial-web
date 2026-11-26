import joeBloggs from "@/data/farms/joe-bloggs.json";
import patMurphy from "@/data/farms/pat-murphy.json";
import seanDoyle from "@/data/farms/sean-doyle.json";
import siobhanKelly from "@/data/farms/siobhan-kelly.json";
import tomWalsh from "@/data/farms/tom-walsh.json";
import { getMilkPrice } from "@/lib/market";
import { buildTaxPaymentsInput, householdTax, runTax, taxAssets, taxPaymentsByMonth, yearEndValues } from "@/lib/financials/tax";
import { HERD_GROUPS, MATURE_GROUPS } from "@/lib/farm-edits-core";
import { cfForecast, cfMonths, cfReconcile, debtCapacity, herdValuation, kpiSummary, loanSchedule, plCompare, plForecast, plMonths, taxPayments, vatFlatRate } from "@/lib/financial-engine/client";

/**
 * Platform-owned farm data (one JSON per demo user) and the engine payloads
 * built from it. Builders only move numbers around — no financial maths.
 *
 * Farm JSON: `months` = this year's actuals (Jan..actual_through_month), `prior_year` = last year's
 * actuals (history for the engine forecast). Projected months come from pl.forecast / cf.forecast.
 */

/**
 * Demo farms (all dairy: the engine is dairy-only). Two owner accounts: Joe (a year of records) and Seán (just signed up:
 * starter estimates, `profile.starter`). The advisor's clients are the four farms with records.
 */
export const FARMS = { "joe-bloggs": joeBloggs, "pat-murphy": patMurphy, "siobhan-kelly": siobhanKelly, "tom-walsh": tomWalsh, "sean-doyle": seanDoyle };

export function getFarm(id = "joe-bloggs") {
  return Object.hasOwn(FARMS, id) ? FARMS[id] : undefined;
}

/** Engine month is projected if it is after the last actual month. */
export function isProjected(farm, month) {
  return month > farm.actual_through_month;
}

/** loan.schedule input: numbers only, in the same order as `farm.loans` (names/lenders stay here). */
export function buildLoanScheduleInput(farm) {
  return {
    loans: farm.loans.map((l) => ({
      balance: l.balance,
      annual_rate: l.annual_rate,
      remaining_months: l.remaining_months,
      year: l.next_payment.year,
      month: l.next_payment.month,
      ...(l.original_principal == null ? {} : { original_principal: l.original_principal }),
      ...(l.rate_type === "Variable" ? { variable: true } : {}), // reprices under rate shocks (ADR-0043)
    })),
  };
}

/** Combined debt service per month from loan.schedule (engine output), keyed by month. */
function debtByMonth(farm, loans) {
  return new Map(loans?.months.filter((m) => m.period.year === farm.year).map((m) => [m.period.month, m]) ?? []);
}

const actual = (farm) => farm.months.filter((m) => m.month <= farm.actual_through_month);
const plItem = (year, m) => ({ year, month: m.month, ...m.lines, ...m.pl });
const cfItem = (year, m) => ({ year, month: m.month, ...m.lines, ...m.cash });
/** Months still to forecast this year (after the last actual, through December). */
const ahead = (farm) => Array.from({ length: 12 - farm.actual_through_month }, (_, i) => farm.actual_through_month + 1 + i);
/** Forecast `inputs` plug into pl.months / cf.months once given their period back. */
const projected = (forecast) => forecast?.months.map((f) => ({ year: f.period.year, month: f.period.month, ...f.inputs })) ?? [];

/** Milk price for a projected month: the farmer's own figure if set, else the platform market adapter. */
export const forecastMilkPrice = (farm, month) => farm.market?.milk_price ?? getMilkPrice(farm.year, month);

/**
 * pl.forecast input: last year + this year's actuals as history; known drivers for the projected months
 * (market milk price from the platform adapter, loan repayments from the engine's loan schedule).
 */
export function buildPlForecastInput(farm, loans) {
  const debt = debtByMonth(farm, loans);
  return {
    history: [...farm.prior_year.map((m) => plItem(farm.year - 1, m)), ...actual(farm).map((m) => plItem(farm.year, m))],
    forecast: ahead(farm).map((month) => ({
      year: farm.year,
      month,
      milk_price: forecastMilkPrice(farm, month),
      ...(debt.get(month) ? { loan_repayments: debt.get(month).payment } : {}),
    })),
  };
}

const monthKey = (year, month) => `${year}-${month}`;

/**
 * Flat-rate VAT addition (engine ADR-0055): farm income on the P&L and money in on the cash flow, so each month's
 * vat.flat_rate `addition` goes on that month as `flat_rate_addition`. Only once the farmer has said they're a
 * flat-rate farmer (not VAT-registered); never assumed. Two calls (this year: actual + forecast; last year) so the
 * tax card can quote this year's total and comparisons with last year stay like for like.
 * @returns {Promise<{ thisYear: object, priorYear: object | null, byMonth: Map<string, number> } | null>}
 */
async function flatRateAdditions(farm, plForecastResult) {
  if (farm.tax?.vat !== "flat_rate") return null;
  const thisYear = [...actual(farm).map((m) => plItem(farm.year, m)), ...projected(plForecastResult)];
  const prior = (farm.prior_year ?? []).map((m) => plItem(farm.year - 1, m));
  const [cur, prev] = await Promise.all([
    vatFlatRate({ months: thisYear, vat_registered: false }),
    prior.length ? vatFlatRate({ months: prior, vat_registered: false }) : null,
  ]);
  const byMonth = new Map(
    [cur, prev]
      .flatMap((r) => (r?.status === "ok" ? r.result.months : []))
      .filter((m) => m.addition > 0)
      .map((m) => [monthKey(m.period.year, m.period.month), m.addition]),
  );
  return { thisYear: cur, priorYear: prev, byMonth };
}

/** A copy of the farm with the flat-rate addition on every recorded month (this year's and last year's). */
function withFlatRate(farm, fra) {
  if (!fra?.byMonth.size) return farm;
  const f = structuredClone(farm);
  const put = (year) => (m) => {
    const addition = fra.byMonth.get(monthKey(year, m.month));
    if (addition) m.lines = { ...m.lines, flat_rate_addition: addition };
  };
  f.months.forEach(put(f.year));
  (f.prior_year ?? []).forEach(put(f.year - 1));
  return f;
}

/** The flat-rate addition on projected months (engine forecast inputs), which the farm file doesn't hold. */
const projectedWithFlatRate = (forecast, fra) =>
  projected(forecast).map((m) => {
    const addition = fra?.byMonth.get(monthKey(m.year, m.month));
    return addition ? { ...m, flat_rate_addition: addition } : m;
  });

/** pl.months input: actual months + the engine's projected inputs, and YTD through the last actual month. */
export function buildPlMonthsInput(farm, plForecastResult, fra = null) {
  return {
    months: [...actual(farm).map((m) => plItem(farm.year, m)), ...projectedWithFlatRate(plForecastResult, fra)],
    ytd: { year: farm.year, as_of_month: farm.actual_through_month },
  };
}

/**
 * kpi.summary input: the actual months of the P&L input (same items) + herd/land size and current debt.
 * @param {object} farm
 * @param {{ months: object[] }} plInput  the pl.months body that was sent
 * @param {import("@/lib/financial-engine/client").LoanScheduleResult | null} loans
 */
export function buildKpiInput(farm, plInput, loans) {
  return {
    months: plInput.months.filter((m) => m.month <= farm.actual_through_month),
    ...(farm.milking_cows == null ? {} : { milking_cows: farm.milking_cows }), // omitted → engine asks (needs_input)
    ...(farm.hectares == null ? {} : { hectares: farm.hectares }),
    ...(loans ? { debt_balance: loans.total_balance } : {}),
  };
}

/**
 * The filed accounts of the last 3 years the farmer gave in Farm data (net profit, depreciation, interest from the
 * accounts; the year's tax from the return), oldest first. Years with a figure missing are left out.
 */
export function filedYears(farm) {
  const t = farm.tax ?? {};
  return [3, 2, 1]
    .map((n) => farm.year - n)
    .map((y) => ({ tax_year: y, net_profit: t.filed_net_profit?.[y], depreciation: t.filed_depreciation?.[y], interest: t.filed_interest?.[y], total_tax: t.past_tax?.[y] }))
    .filter((y) => Object.values(y).every((v) => v != null));
}

/**
 * debt.capacity input: the year's P&L months (actual + forecast) and the household budget and
 * new-loan terms the platform holds (drawings / tax are platform data; min cover is lender policy).
 */
export function buildDebtCapacityInput(farm, plInput, tax = householdTax(farm, null)) {
  const h = farm.household ?? {};
  const t = farm.new_loan_terms ?? {};
  const filed = filedYears(farm);
  return {
    // banks read the last 3 years of filed accounts: the engine sizes the loan on them too (12 months only, ADR-0055)
    ...(filed.length && plInput.months.length === 12 ? { filed_years: filed } : {}),
    months: plInput.months,
    ...(t.annual_rate == null ? {} : { annual_rate: t.annual_rate }),
    ...(t.term_months == null ? {} : { term_months: t.term_months }),
    ...(t.min_cover == null ? {} : { min_cover: t.min_cover }),
    ...(h.drawings_per_year == null ? {} : { drawings: h.drawings_per_year }),
    // with whose figure it is (the accountant's or the engine's estimate), so the engine and reports can say (ADR-0055)
    ...(tax == null ? {} : { tax: tax.amount, tax_source: tax.source }),
    ...(h.off_farm_income_per_year == null ? {} : { off_farm_income: h.off_farm_income_per_year }),
  };
}

/**
 * debt.capacity inputs on actual months only, for a prudent "could the farm take on a new loan?":
 * the last 12 actual months (end of last year + this year so far) and last calendar year. No forecast:
 * a loan is a long commitment, so it is sized on what actually happened. Periods without 12 months
 * of records are left out.
 * @returns {{ key: "last12" | "lastYear", input: object }[]}
 */
export function buildHistoricDebtCapacityInputs(farm, tax = householdTax(farm, null)) {
  const end = farm.actual_through_month;
  const prior = farm.prior_year ?? [];
  const last12 = [...prior.filter((m) => m.month > end).map((m) => plItem(farm.year - 1, m)), ...actual(farm).map((m) => plItem(farm.year, m))];
  const lastYear = prior.map((m) => plItem(farm.year - 1, m));
  return [
    { key: "last12", months: last12 },
    { key: "lastYear", months: lastYear },
  ]
    .filter((p) => p.months.length === 12)
    .map(({ key, months }) => ({ key, input: buildDebtCapacityInput(farm, { months }, tax) }));
}

/**
 * milk.quality input (ADR-0052): the co-op milk-statement figures of the latest `count` months that have
 * them (`quality` on each month, litres from the P&L record), with herd size and the averages to compare with.
 * @param {object} farm
 * @param {{ count?: number, benchmarks?: object }} [options]
 */
export function buildMilkQualityInput(farm, { count = 12, benchmarks } = {}) {
  const records = [
    ...(farm.prior_year ?? []).map((m) => ({ year: farm.year - 1, m })),
    ...actual(farm).map((m) => ({ year: farm.year, m })),
  ].filter(({ m }) => m.quality);
  return {
    months: records.slice(-count).map(({ year, m }) => ({ year, month: m.month, milk_litres: m.pl.milk_litres, ...m.quality })),
    ...(farm.milking_cows == null ? {} : { milking_cows: farm.milking_cows }),
    ...(farm.hectares == null ? {} : { hectares: farm.hectares }),
    ...(benchmarks && Object.keys(benchmarks).length ? { benchmarks } : {}),
  };
}

/** pl.compare input: this year's actual months vs the same months last year. */
export function buildPlCompareInput(farm) {
  const months = new Set(actual(farm).map((m) => m.month));
  return {
    actual: actual(farm).map((m) => plItem(farm.year, m)),
    comparison: farm.prior_year.filter((m) => months.has(m.month)).map((m) => plItem(farm.year - 1, m)),
  };
}

/** cf.compare input: this year's actual cash months vs the same months last year (money in / out so far, by line). */
export function buildCfCompareInput(farm) {
  const months = new Set(actual(farm).map((m) => m.month));
  return {
    actual: actual(farm).map((m) => cfItem(farm.year, m)),
    comparison: farm.prior_year.filter((m) => months.has(m.month)).map((m) => cfItem(farm.year - 1, m)),
  };
}

/**
 * cf.forecast input. Known values for projected months: the milk cheque (paid the month after supply,
 * so the engine-published milk revenue of the month before, at the market price) and loan principal /
 * interest from the loan schedule. Everything else recurs from history (incl. household drawings).
 *
 * @param {object} farm
 * @param {import("@/lib/financial-engine/client").PlMonthsResult} pl
 * @param {import("@/lib/financial-engine/client").LoanScheduleResult} loans
 */
export function buildCfForecastInput(farm, pl, loans, taxCash = new Map()) {
  const milkByMonth = new Map(pl.months.map((s) => [s.period.month, s.revenue.milk]));
  const debt = debtByMonth(farm, loans);
  return {
    history: [...farm.prior_year.map((m) => cfItem(farm.year - 1, m)), ...actual(farm).map((m) => cfItem(farm.year, m))],
    forecast: ahead(farm).map((month) => {
      const d = debt.get(month);
      const milk = milkByMonth.get(month - 1);
      return {
        year: farm.year,
        month,
        ...(milk == null ? {} : { milk }),
        ...(d ? { loan_principal_repayments: d.principal, interest_paid: d.interest } : {}),
        // the autumn tax bill from tax.payments (taxPaymentsByMonth): the engine never projects it (ADR-0055)
        ...(taxCash.get(month) ? { tax_payments: taxCash.get(month) } : {}),
      };
    }),
  };
}

/** cf.months input: opening bank balance + actual cash months + the engine's projected cash inputs. */
export function buildCfMonthsInput(farm, cfForecastResult, fra = null) {
  return {
    ...(farm.opening_cash == null ? {} : { opening_cash: farm.opening_cash }),
    months: [...actual(farm).map((m) => cfItem(farm.year, m)), ...projectedWithFlatRate(cfForecastResult, fra)],
  };
}

/**
 * herd.valuation input (ADR-0055): the herd groups the farmer gave in Farm data, valued at 31 December this year.
 * Head and market value a head for every group with head; the value held a head for mature breeding stock (cows,
 * bulls). A figure not given isn't sent, so the engine asks for it (needs_input with its path). null without groups.
 */
export function buildHerdInput(farm) {
  const groups = HERD_GROUPS.map((category) => ({ category, ...farm.herd?.[category] }))
    .filter((g) => g.head > 0)
    .map(({ category, head, market, held }) => ({
      category,
      head,
      ...(market == null ? {} : { unit_market_value: market }),
      ...(MATURE_GROUPS.includes(category) && held != null ? { unit_held_value: held } : {}),
    }));
  return groups.length ? { year: farm.year, month: 12, groups } : null;
}

/**
 * cf.reconcile input (ADR-0055): the year's P&L and cash months as sent (actual + forecast, Jan–Dec), the herd and
 * stock values pl.net uses, and the balances at both ends the farmer gave in Farm data (milk money owed to the farm,
 * merchant / co-op credit). A balance not given isn't sent, so the bridge leaves it out and says so.
 */
export function buildReconcileInput(farm, inputs, herd = null) {
  const y = farm.year_end ?? {};
  const pair = (engine, key) => ({
    ...(y[`${key}_start`] == null ? {} : { [`${engine}_opening`]: y[`${key}_start`] }),
    ...(y[`${key}_end`] == null ? {} : { [`${engine}_closing`]: y[`${key}_end`] }),
  });
  return {
    pl_months: inputs["pl.months"].months,
    cf_months: inputs["cf.months"].months,
    ...yearEndValues(farm, herd),
    ...pair("milk_debtors", "milk_owed"),
    ...pair("merchant_credit", "merchant_credit"),
  };
}

/**
 * The engine chain for one farm (later calls need earlier results):
 * loan.schedule → pl.forecast → vat.flat_rate → pl.months (+ kpi.summary, pl.compare, tax, debt.capacity) → cf.forecast
 * → cf.months. The forecasts run on the farm's own records; the flat-rate addition goes on the months after (the engine
 * works it out from each month's sales, it isn't a run-rate). `farm` in the result has it on every month: pages build
 * later engine calls (compare, borrowing, plan, reports) from that farm, so every page counts it the same way.
 * `prepare(fn, input)` may adjust each input before it is sent (e.g. farmer answers to needs_input).
 * Returns the engine responses plus the exact inputs sent, which Biddy's agents also receive.
 * If a forecast fails, the year shows actual months only and `plf` / `cff` carry the reason.
 */
export async function runFarm(raw, prepare = (_fn, input) => input) {
  const inputs = {};
  const send = (fn, call, input) => call((inputs[fn] = prepare(fn, input)));
  const result = (r) => (r?.status === "ok" ? r.result : null);
  const hasAhead = ahead(raw).length > 0;
  let farm = raw;

  // No loans is a normal farm: loan.schedule wants at least one, so it isn't called and nothing is repaid.
  const hasLoans = farm.loans?.length > 0;
  const loans = hasLoans ? await send("loan.schedule", loanSchedule, buildLoanScheduleInput(farm)) : null;
  if (!hasLoans) inputs["loan.schedule"] = { loans: [] };
  const plf = hasAhead ? await send("pl.forecast", plForecast, buildPlForecastInput(farm, result(loans))) : null;
  // P&L still runs without loans: repayments sit outside Operating Surplus, so surplus figures stay right.
  const fra = await flatRateAdditions(raw, result(plf));
  farm = withFlatRate(raw, fra);
  const pl = await send("pl.months", plMonths, buildPlMonthsInput(farm, result(plf), fra));
  const kpi = await send("kpi.summary", kpiSummary, buildKpiInput(farm, inputs["pl.months"], result(loans)));
  const plc = farm.prior_year?.length ? await send("pl.compare", plCompare, buildPlCompareInput(farm)) : null;
  // Tax for the year (when the farm has a tax profile): the household tax lenders see is the accountant's figure,
  // else this estimate.
  // The herd at 31 Dec on market value and Revenue practice: the Revenue-practice total is the year-end herd value
  // for profit, tax and the cash bridge; the market value is for a bank.
  const herdInput = buildHerdInput(farm);
  const herd = herdInput ? await send("herd.valuation", herdValuation, herdInput) : null;
  const tax = pl.status === "ok" ? await runTax(farm, inputs, result(loans), fra, herd) : null;
  const cap = await send("debt.capacity", debtCapacity, buildDebtCapacityInput(farm, inputs["pl.months"], householdTax(farm, tax)));
  // This autumn's tax bill (preliminary + last year's balance), once the farmer has answered how they pay it.
  const paymentsInput = buildTaxPaymentsInput(farm, householdTax(farm, tax));
  const payments = paymentsInput ? await send("tax.payments", taxPayments, paymentsInput) : null;
  const taxCash = taxPaymentsByMonth(farm, payments);

  let cff = null;
  let cf;
  if (pl.status !== "ok") {
    cf = { status: "error", error: { code: "needs_pl", message: "Cash flow needs the monthly P&L first." } };
  } else if (hasLoans && !result(loans)) {
    cf = { status: "error", error: { code: "needs_loans", message: "Cash flow needs the loan schedule first." } };
  } else {
    // history without the flat-rate addition, as for pl.forecast: it goes on the projected months from vat.flat_rate
    cff = hasAhead ? await send("cf.forecast", cfForecast, buildCfForecastInput(raw, pl.result, result(loans), taxCash)) : null;
    cf = await send("cf.months", cfMonths, buildCfMonthsInput(farm, result(cff), fra));
  }
  // From accounts profit to cash for the same 12 months (a bank or accountant checks this before trusting the months).
  const twelve = inputs["pl.months"]?.months.length === 12 && inputs["cf.months"]?.months.length === 12;
  const recon = pl.status === "ok" && cf.status === "ok" && twelve ? await send("cf.reconcile", cfReconcile, buildReconcileInput(farm, inputs, herd)) : null;

  return { farm, fra, inputs, loans, plf, pl, kpi, plc, cap, cff, cf, tax, payments, taxCash, recon, herd };
}

/**
 * risk.sensitivity input from the inputs runFarm sent (same P&L and cash months as the page).
 * Shocks start at the first projected month (ADR-0040): actual months stay as they happened.
 * The loans behind the months' loan lines go too, so `rate_shift_pp` can reprice the variable ones (ADR-0043).
 */
export function buildRiskInput(farm, inputs, scenarios = []) {
  const from = ahead(farm)[0];
  return {
    pl_months: inputs["pl.months"].months,
    cf_months: inputs["cf.months"].months,
    opening_cash: inputs["cf.months"].opening_cash,
    loans: inputs["loan.schedule"].loans,
    ...(from ? { shocks_from_year: farm.year, shocks_from_month: from } : {}),
    ...(scenarios.length ? { scenarios } : {}),
  };
}

/**
 * Farm file for report.bank / report.advisor / report.accountant (ADR-0041), built from the inputs
 * runFarm sent so reports and screens agree. Period = actual months; projections = forecast inputs.
 * Balances, valuations and the asset register are platform records at the report date.
 */
export function buildReportInput(farm, inputs, scenarios = []) {
  const isActual = (m) => m.year === farm.year && m.month <= farm.actual_through_month;
  const bs = farm.balance_sheet ?? {};
  const paid = farm.household_paid_to_date ?? {};
  const t = farm.new_loan_terms;
  const months = new Set(actual(farm).map((m) => m.month));
  return {
    pl_months: inputs["pl.months"].months.filter(isActual),
    cf_months: inputs["cf.months"].months.filter(isActual),
    projected_pl_months: inputs["pl.months"].months.filter((m) => !isActual(m)),
    projected_cf_months: inputs["cf.months"].months.filter((m) => !isActual(m)),
    opening_cash: inputs["cf.months"].opening_cash,
    ...(farm.milking_cows == null ? {} : { milking_cows: farm.milking_cows }),
    ...(farm.hectares == null ? {} : { hectares: farm.hectares }),
    prior_pl_months: (farm.prior_year ?? []).filter((m) => months.has(m.month)).map((m) => plItem(farm.year - 1, m)),
    loans: inputs["loan.schedule"].loans,
    assets: (farm.assets ?? []).map(({ id, name, ...asset }) => asset),
    debtors: bs.debtors ?? 0,
    stock: bs.stock ?? 0,
    livestock: bs.livestock ?? 0,
    land: bs.land ?? 0,
    creditors: farm.suppliers?.total_outstanding ?? 0,
    other_long_term_liabilities: bs.other_long_term_liabilities ?? 0,
    ...(bs.livestock_opening_value == null ? {} : { livestock_opening_value: bs.livestock_opening_value }),
    ...(bs.stock_opening_value == null ? {} : { stock_opening_value: bs.stock_opening_value }),
    drawings: paid.drawings ?? 0,
    tax: paid.tax ?? 0,
    tax_source: farm.household?.tax_per_year != null ? "accountant" : "estimate", // required with tax (ADR-0055)
    // no filed_years: the report's period is the actual months and the engine compares filed accounts with 12 months
    // only. The bank report shows runFarm's 12-month debt.capacity, which carries them.
    off_farm_income: paid.off_farm_income ?? 0,
    ...(t ? { new_loan: { annual_rate: t.annual_rate, term_months: t.term_months, min_cover: t.min_cover } } : {}),
    ...(scenarios.length ? { scenarios } : {}),
  };
}

/**
 * plan.projection input (ADR-0042). Base = the last 12 actual months (end of last year + this year);
 * opening cash = the engine's month-end balance at the end of the base. Assumptions come from a preset
 * the advisor holds, with the farmer's overrides; investments from the platform's list.
 *
 * @param {object} farm
 * @param {object} inputs   what runFarm sent
 * @param {import("@/lib/financial-engine/client").CfMonthsResult} cash  cf.months result
 * @param {{ assumptions: object, investments: object[], years?: number }} plan
 */
export function buildPlanInput(farm, inputs, cash, { assumptions, investments, years = 5, taxProfile = null }) {
  const end = farm.actual_through_month;
  // With a tax profile the engine adds the flat-rate addition itself: base months carrying it are refused (fra_conflict).
  const own = ({ flat_rate_addition: _, ...m }) => m;
  const base = [
    ...farm.prior_year.filter((m) => m.month > end).map((m) => plItem(farm.year - 1, m)),
    ...actual(farm).map((m) => plItem(farm.year, m)),
  ].map((m) => (taxProfile ? own(m) : m));
  const bs = farm.balance_sheet ?? {};
  return {
    base_pl_months: base,
    opening_cash: cash.months.find((m) => m.period.year === farm.year && m.period.month === end)?.closing_cash,
    ...(farm.milking_cows == null ? {} : { milking_cows: farm.milking_cows }),
    years,
    assumptions,
    loans: inputs["loan.schedule"].loans,
    assets: (farm.assets ?? []).map(({ id, name, ...asset }) => asset),
    ...(bs.land == null ? {} : { land: bs.land }),
    ...(bs.livestock == null ? {} : { livestock: bs.livestock }),
    ...(farm.new_loan_terms?.min_cover == null ? {} : { min_cover: farm.new_loan_terms.min_cover }),
    ...(investments.length ? { investments } : {}),
    // Tax worked out per year from the farmer's tax profile (ADR-0053), with each asset's grant and allowance type.
    ...(taxProfile ? { tax_profile: taxProfile, assets: taxAssets(farm) } : {}),
  };
}
