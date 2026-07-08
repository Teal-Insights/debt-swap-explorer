/* Debt swap cash-flow engine.
 *
 * Mirrors model/debt_swap_model.py line for line. The Python version is the
 * reference implementation (tested against the World Bank Debt Swap
 * Calculator User Guide example, July 2025); this file must produce
 * identical numbers. Conventions:
 *   - Annual periods. Year 0 = today, no payments in it.
 *   - Mid-year discounting: DF(t) = 1/(1+y)^(t-0.5), t = 1..H.
 *   - Interest accrues on principal outstanding at the start of the year.
 */

const SwapModel = (() => {

  function buybackCost(inst) {
    if (inst.kind === "loan") return inst.principal * (1 + inst.fee);
    return inst.principal * (inst.price + 100 * inst.fee) / 100;
  }

  function principalSchedule(inst, horizon) {
    const pay = new Array(horizon).fill(0);
    if (inst.profile === "equal") {
      const n = inst.maturity - inst.grace;
      const per = inst.principal / n;
      for (let t = inst.grace + 1; t <= inst.maturity; t++) pay[t - 1] = per;
    } else if (inst.profile === "maturity") {
      pay[inst.maturity - 1] = inst.principal;
    } else if (inst.profile === "last3") {
      const k = Math.min(3, inst.maturity);
      const per = inst.principal / k;
      for (let t = inst.maturity - k + 1; t <= inst.maturity; t++) pay[t - 1] = per;
    }
    return pay;
  }

  function cashFlows(inst, horizon) {
    const prin = principalSchedule(inst, horizon);
    const interest = new Array(horizon).fill(0);
    let outstanding = inst.principal;
    for (let t = 1; t <= inst.maturity; t++) {
      interest[t - 1] = outstanding * inst.rate;
      outstanding -= prin[t - 1];
    }
    return { prin, interest };
  }

  function interpYield(curve, d) {
    /* Linear interpolation between observed points, flat extrapolation,
     * capped 0-30%: the WB calculator's deployed behavior. */
    const pts = [...curve].sort((a, b) => a[0] - b[0]);
    let y;
    if (d <= pts[0][0]) y = pts[0][1];
    else if (d >= pts[pts.length - 1][0]) y = pts[pts.length - 1][1];
    else {
      for (let i = 0; i < pts.length - 1; i++) {
        const [d0, y0] = pts[i], [d1, y1] = pts[i + 1];
        if (d0 <= d && d <= d1) { y = y0 + (y1 - y0) * (d - d0) / (d1 - d0); break; }
      }
    }
    return Math.min(Math.max(y, 0), 0.3);
  }

  function discountFactors(horizon, flat, curve) {
    const dfs = [];
    for (let t = 1; t <= horizon; t++) {
      const y = (flat !== null && flat !== undefined) ? flat : interpYield(curve, t);
      dfs.push(1 / Math.pow(1 + y, t - 0.5));
    }
    return dfs;
  }

  function spendingFlows(commit, horizon) {
    const out = new Array(horizon).fill(0);
    if (!commit || !commit.years) return out;
    for (let t = commit.start; t < commit.start + commit.years; t++) {
      if (t >= 1 && t <= horizon) out[t - 1] = commit.annual;
    }
    return out;
  }

  const sum = a => a.reduce((x, y) => x + y, 0);
  const dot = (a, b) => a.reduce((x, y, i) => x + y * b[i], 0);

  function run(existing, newDebt, commit, opts) {
    const { flat = 0.05, curve = null, subsidy = 0, autoAmount = true } = opts || {};
    const horizon = Math.max(...existing.map(i => i.maturity), newDebt.maturity);
    const buyback = sum(existing.map(buybackCost));
    const amount = autoAmount ? buyback : newDebt.amount;

    let oldService = new Array(horizon).fill(0);
    for (const inst of existing) {
      const { prin, interest } = cashFlows(inst, horizon);
      oldService = oldService.map((v, i) => v + prin[i] + interest[i]);
    }

    const newInst = { kind: "loan", principal: amount, rate: newDebt.rate,
      maturity: newDebt.maturity, profile: newDebt.profile,
      grace: newDebt.grace, fee: 0, price: 100 };
    const { prin, interest } = cashFlows(newInst, horizon);
    const newService = prin.map((v, i) => v + interest[i]);

    const spending = spendingFlows(commit, horizon);
    const dfs = discountFactors(horizon, curve ? null : flat, curve);
    const fees = newDebt.upfrontFees || 0;

    const savingsByYear = oldService.map((v, i) => v - newService[i]);
    const nominalOver = n => sum(savingsByYear.slice(0, n)) - fees;
    const npvSavings = dot(savingsByYear, dfs) - fees;
    const pvSpending = dot(spending, dfs);
    const fiscalSpace = savingsByYear.map((v, i) => v - spending[i]);
    const atm = flows => {
      const tot = sum(flows);
      return tot === 0 ? 0 :
        flows.reduce((x, f, t) => x + f * (t + 0.5), 0) / tot;
    };
    const pvOld = dot(oldService, dfs);

    /* WB dashboard's "savings from maturity extension": a duration-matching
     * heuristic, not a cash flow. amount x marginal rate x ATM extension,
     * floored at 0. Guide behavior: rate = selected discount factor (fixed
     * mode) or the curve yield at the extension tenor (curve mode). The
     * DEPLOYED fixed-mode code hardcodes 5%; we follow the guide. */
    const ext = atm(newService) - atm(oldService);
    const extRate = curve ? interpYield(curve, Math.max(1, Math.round(ext))) : flat;
    const extensionSavings = Math.max(0, amount * extRate * ext);

    return {
      horizon, oldService, newService, spending, dfs,
      buybackCost: buyback, amount, fees, savingsByYear,
      nominalOver1: nominalOver(1), nominalOver2: nominalOver(2),
      nominalOver3: nominalOver(3), nominalOver5: nominalOver(5),
      npvSavings, pvSpending, npvNetOfSpending: npvSavings - pvSpending,
      fiscalSpace, atmOld: atm(oldService), atmNew: atm(newService),
      extensionSavings,
      pvOld, buybackVsPv: pvOld - buyback,
      leverage: subsidy > 0 ? pvSpending / subsidy : null,
      subsidy,
    };
  }

  return { run, buybackCost, discountFactors, interpYield };
})();

/* Self-check against the Python reference (default scenario = the WB User
 * Guide worked example). Logged to the console on load. */
function swapModelSelfCheck() {
  const existing = [
    { kind: "loan", principal: 100, rate: 0.05, maturity: 4, profile: "equal", grace: 0, fee: 0, price: 100 },
    { kind: "loan", principal: 30, rate: 0.03, maturity: 5, profile: "equal", grace: 3, fee: 0, price: 100 },
    { kind: "loan", principal: 60, rate: 0.04, maturity: 4, profile: "maturity", grace: 0, fee: 0, price: 100 },
    { kind: "bond", principal: 150, rate: 0.08, maturity: 15, profile: "last3", grace: 0, fee: 0, price: 80 },
  ];
  const r = SwapModel.run(existing,
    { rate: 0.05, maturity: 10, profile: "equal", grace: 5, upfrontFees: 5 },
    { annual: 8, start: 1, years: 15 }, { flat: 0.05, subsidy: 30 });
  const close = (a, b, tol = 1e-4) => Math.abs(a - b) < tol;
  const ok = close(r.buybackCost, 310) &&
    close(r.nominalOver1, 24.8) && close(r.nominalOver2, 53.35) &&
    close(r.nominalOver3, 80.65) && close(r.nominalOver5, 193.65) &&
    close(r.npvSavings, 66.7467) && close(r.pvSpending, 85.0879) &&
    close(r.atmOld, 7.0807) && close(r.atmNew, 6.5357) &&
    close(r.buybackVsPv, 79.4022);
  console.log(ok ?
    "SwapModel self-check PASSED (matches Python reference implementation)" :
    "SwapModel self-check FAILED", r);
  return ok;
}
