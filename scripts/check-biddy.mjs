// Self-check for the Biddy figure helpers: `npm run check`.
import assert from "node:assert/strict";
import { fillTemplate, pickTemplate, unverifiedFigures, valueAt } from "../lib/biddy-figures.js";
import fixtures from "../data/biddy/fixtures.json" with { type: "json" };

const response = { status: "ok", result: { closing_cash: 150263.65, months: [{ closing_cash: -8274.08 }], ytd: { margin_pct: 46.72 }, min_cover: 1.25, term: 84 } };

assert.equal(valueAt(response, "result.months[0].closing_cash"), -8274.08);
assert.equal(valueAt(response, "result.nope[3].x"), undefined);

const { text, figures_used } = fillTemplate("Dec {result.closing_cash}, low {result.months[0].closing_cash}, {result.ytd.margin_pct|pct}, {result.missing}", response);
assert.equal(text, "Dec €150,264, low -€8,274, 47%, —");
assert.equal(figures_used.length, 3);
assert.equal(fillTemplate("{result.min_cover|times} over {result.term|months}", response).text, "1.25× over 84 months");

const answer = { results: [{ response }], figures_used };
assert.deepEqual(unverifiedFigures(answer), []);
assert.equal(unverifiedFigures({ ...answer, figures_used: [{ result: 0, path: "result.closing_cash", value: 1 }] }).length, 1);

console.log("biddy figures ok");

// variants: the cash answer must not say "Yes" when the forecast is overdrawn
const cashIntent = fixtures.intents.find((i) => i.id === "cash");
const cashAt = (nov, dec) => ({ status: "ok", result: { closing_cash: dec, months: Object.assign(Array(12).fill({}), { 10: { closing_cash: nov } }) } });
assert.match(pickTemplate(cashIntent, cashAt(55000, 79470)), /^Yes/);
assert.match(pickTemplate(cashIntent, cashAt(-14684, -33414)), /^Not without/);
assert.match(pickTemplate(cashIntent, cashAt(5000, -3453)), /^Not without/);
assert.equal(pickTemplate({ text: "plain" }, cashAt(-1, -1)), "plain");
const borrowIntent = fixtures.intents.find((i) => i.id === "borrow");
assert.match(pickTemplate(borrowIntent, { status: "ok", result: { new_loan: { max_principal: 0 } } }), /^Not at the moment/);
assert.match(pickTemplate(borrowIntent, { status: "ok", result: { new_loan: { max_principal: 120000 } } }), /^Based on/);
console.log("biddy variants ok");

// routing (lib/biddy.js mockAgent: first intent whose match is in the question): the engine 1.11.0 questions reach
// their own function, not the general cash / profit answers
const route = (q) => fixtures.intents.find((i) => i.match.some((m) => q.toLowerCase().includes(m)))?.function;
assert.equal(route("How much tax is due this autumn?"), "tax.payments");
assert.equal(route("What's my preliminary tax?"), "tax.payments");
assert.equal(route("Why is my cash different from my profit?"), "cf.reconcile");
assert.equal(route("Why is my cash lower than my profit?"), "cf.reconcile");
assert.equal(route("What’s my herd worth?"), "herd.valuation");
assert.equal(route("Will I have cash for the December feed bill?"), "cf.months");
assert.equal(route("Am I profitable this year?"), "pl.months");
console.log("biddy routing ok");
