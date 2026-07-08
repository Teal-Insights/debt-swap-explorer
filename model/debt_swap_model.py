"""Debt swap cash-flow model, from first principles.

Two modes:
  1. "WB replication" mode: reproduces the World Bank Debt Swap Calculator
     (Mihalyi & Rivetti, July 2025) exactly, based on a line-by-line read of
     the deployed calculations.js.
  2. "Extended" mode: adds the legs the WB tool omits, so the numbers a
     Ministry of Finance, a funder, and an investor each need come from one
     explicit set of annual cash flows:
       - the development spending commitment (the swap leg)
       - the funder subsidy and leverage metrics
       - the investor-side value of the buyback (PV of old flows at market
         yields vs. price paid)

Conventions (matching the WB calculator where they are defensible):
  - Annual periodicity. Year 0 is the current year; no payments occur in it.
  - Mid-year discounting: cash in year t (t >= 1) is discounted by
    1/(1+d)^(t-0.5).
  - Interest accrues on principal outstanding at the start of each year.
  - Repayment profiles: equal installments after grace, bullet at maturity,
    or equal thirds over the last three years.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Instrument:
    """One existing debt instrument to be repurchased."""

    kind: str  # "loan" or "bond"
    principal: float  # outstanding, m$
    rate: float  # fixed annual coupon/interest, decimal
    maturity: int  # years from now to final maturity (e.g. 4 = year 4)
    profile: str = "equal"  # "equal" | "maturity" | "last3"
    grace: int = 0  # remaining grace years (loans; bonds -> 0)
    fee: float = 0.0  # prepayment fee / buyback premium, decimal
    price: float = 100.0  # market price, % of par (bonds only)

    def buyback_cost(self) -> float:
        """Cash needed at t=0 to retire this instrument.

        Matches the WB calculator's auto-calculated 'new debt amount':
          loans:  principal * (1 + fee)
          bonds:  principal * (price + fee_pct) / 100
        """
        if self.kind == "loan":
            return self.principal * (1.0 + self.fee)
        return self.principal * (self.price + 100.0 * self.fee) / 100.0

    def principal_schedule(self, horizon: int) -> list[float]:
        """Principal payments in years 1..horizon (index 0 = year 1)."""
        pay = [0.0] * horizon
        if self.profile == "equal":
            n = self.maturity - self.grace
            per = self.principal / n
            for t in range(self.grace + 1, self.maturity + 1):
                pay[t - 1] = per
        elif self.profile == "maturity":
            pay[self.maturity - 1] = self.principal
        elif self.profile == "last3":
            # Equal thirds in the last three years (or fewer if maturity < 3).
            k = min(3, self.maturity)
            per = self.principal / k
            for t in range(self.maturity - k + 1, self.maturity + 1):
                pay[t - 1] = per
        else:
            raise ValueError(f"unknown profile {self.profile}")
        return pay

    def cash_flows(self, horizon: int) -> tuple[list[float], list[float]]:
        """(principal, interest) paid in years 1..horizon."""
        prin = self.principal_schedule(horizon)
        interest = [0.0] * horizon
        outstanding = self.principal
        for t in range(1, self.maturity + 1):
            interest[t - 1] = outstanding * self.rate
            outstanding -= prin[t - 1]
        return prin, interest


@dataclass
class NewDebt:
    """The instrument that funds the buyback."""

    amount: float  # m$ (auto = sum of buyback costs, or manual)
    rate: float
    maturity: int
    profile: str = "equal"
    grace: int = 0
    upfront_fees: float = 0.0  # m$, all transaction costs paid at t=0

    def as_instrument(self) -> Instrument:
        return Instrument(
            kind="loan",
            principal=self.amount,
            rate=self.rate,
            maturity=self.maturity,
            profile=self.profile,
            grace=self.grace,
        )


@dataclass
class SpendingCommitment:
    """The development leg: committed annual spending (m$/yr)."""

    annual: float = 0.0
    start: int = 1  # first year of spending
    years: int = 0  # number of years

    def cash_flows(self, horizon: int) -> list[float]:
        out = [0.0] * horizon
        for t in range(self.start, self.start + self.years):
            if 1 <= t <= horizon:
                out[t - 1] = self.annual
        return out


def discount_factors(horizon: int, flat: float | None = None,
                     curve: list[tuple[float, float]] | None = None) -> list[float]:
    """DF for years 1..horizon, mid-year convention.

    curve: list of (maturity_in_years, yield_decimal) observed points,
    linearly interpolated, flat extrapolation (the WB calculator's actual
    deployed behavior; its user guide describes a log-linear regression fit
    instead, a documented divergence we note in the methodology).
    """
    dfs = []
    for t in range(1, horizon + 1):
        if flat is not None:
            y = flat
        else:
            y = _interp_yield(curve, t)
        dfs.append(1.0 / (1.0 + y) ** (t - 0.5))
    return dfs


def _interp_yield(curve: list[tuple[float, float]], d: float) -> float:
    """Linear interpolation, flat extrapolation, capped 0-30% (the WB
    calculator's deployed behavior)."""
    pts = sorted(curve)
    if d <= pts[0][0]:
        y = pts[0][1]
    elif d >= pts[-1][0]:
        y = pts[-1][1]
    else:
        for (d0, y0), (d1, y1) in zip(pts, pts[1:]):
            if d0 <= d <= d1:
                y = y0 + (y1 - y0) * (d - d0) / (d1 - d0)
                break
    return min(max(y, 0.0), 0.3)


@dataclass
class SwapResult:
    horizon: int
    old_service: list[float]
    new_service: list[float]
    spending: list[float]
    dfs: list[float]
    buyback_cost: float
    upfront_fees: float
    subsidy: float
    flat: float | None = 0.05
    curve: list[tuple[float, float]] | None = None

    # --- MoF (debtor) metrics -------------------------------------------
    @property
    def nominal_savings_by_year(self) -> list[float]:
        return [o - n for o, n in zip(self.old_service, self.new_service)]

    def nominal_savings_over(self, years: int) -> float:
        return sum(self.nominal_savings_by_year[:years]) - self.upfront_fees

    @property
    def npv_savings(self) -> float:
        """PV of debt-service savings net of upfront fees (WB headline)."""
        pv = sum(s * df for s, df in zip(self.nominal_savings_by_year, self.dfs))
        return pv - self.upfront_fees

    @property
    def pv_spending(self) -> float:
        return sum(c * df for c, df in zip(self.spending, self.dfs))

    @property
    def npv_net_of_spending(self) -> float:
        """Net gain after honoring the development commitment."""
        return self.npv_savings - self.pv_spending

    @property
    def fiscal_space_by_year(self) -> list[float]:
        """Old service - new service - committed spending, each year."""
        return [o - n - c for o, n, c in
                zip(self.old_service, self.new_service, self.spending)]

    def atm(self, flows: list[float]) -> float:
        """Debt-service-weighted average time (WB's ATM), mid-year indices."""
        tot = sum(flows)
        if tot == 0:
            return 0.0
        return sum(f * (t + 0.5) for t, f in enumerate(flows)) / tot

    @property
    def extension_savings(self) -> float:
        """The WB dashboard's 'savings from maturity extension' line.

        A duration-matching heuristic, not a cash flow: new-debt amount x
        marginal rate x ATM extension, floored at zero. Per the user guide,
        the marginal rate is the selected discount factor (fixed mode) or
        the curve yield at the extension tenor (curve mode). The deployed
        fixed-mode code hardcodes 5%; we follow the guide.
        """
        ext = self.atm(self.new_service) - self.atm(self.old_service)
        amount = self.buyback_cost
        if self.curve is not None:
            rate = _interp_yield(self.curve, max(1, round(ext)))
        else:
            rate = self.flat if self.flat is not None else 0.05
        return max(0.0, amount * rate * ext)

    # --- Funder metrics ---------------------------------------------------
    @property
    def leverage(self) -> float | None:
        """PV of development spending per $ of funder subsidy."""
        if self.subsidy <= 0:
            return None
        return self.pv_spending / self.subsidy

    # --- Investor / market-consistency metrics ---------------------------
    def pv_old_at_discount(self) -> float:
        return sum(s * df for s, df in zip(self.old_service, self.dfs))

    def buyback_vs_pv(self) -> float:
        """PV of retired flows minus cash paid to retire them.

        Positive: the debtor retires flows worth more (at the chosen
        discount rate) than it pays. This makes explicit the gain the WB
        tool captures only implicitly through the service differential.
        """
        return self.pv_old_at_discount() - self.buyback_cost


def run_swap(existing: list[Instrument], new: NewDebt,
             spending: SpendingCommitment | None = None,
             flat: float | None = 0.05,
             curve: list[tuple[float, float]] | None = None,
             subsidy: float = 0.0,
             auto_amount: bool = True) -> SwapResult:
    horizon = max([i.maturity for i in existing] + [new.maturity])
    buyback = sum(i.buyback_cost() for i in existing)
    if auto_amount:
        new.amount = buyback

    old_p = [0.0] * horizon
    old_i = [0.0] * horizon
    for inst in existing:
        p, i = inst.cash_flows(horizon)
        old_p = [a + b for a, b in zip(old_p, p)]
        old_i = [a + b for a, b in zip(old_i, i)]
    old_service = [a + b for a, b in zip(old_p, old_i)]

    np_, ni = new.as_instrument().cash_flows(horizon)
    new_service = [a + b for a, b in zip(np_, ni)]

    sp = (spending or SpendingCommitment()).cash_flows(horizon)
    dfs = discount_factors(horizon, flat=flat, curve=curve)

    return SwapResult(horizon=horizon, old_service=old_service,
                      new_service=new_service, spending=sp, dfs=dfs,
                      buyback_cost=buyback, upfront_fees=new.upfront_fees,
                      subsidy=subsidy, flat=flat if curve is None else None,
                      curve=curve)
