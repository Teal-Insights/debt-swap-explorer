"""Validation of the model against the World Bank Debt Swap Calculator.

The default scenario is the worked example in the WB Debt Swap Calculator
User Guide (July 2025, pp. 2-4). The guide's Results Dashboard screenshot
shows, for that exact portfolio:

    Nominal savings over 1y / 2y / 3y / 5y : 24.8 / 53.3 / 80.6 / 193.6 m$
    ATM: original 7.1y, new 6.5y, extension -0.5y

Those nominal figures are independent of the discount rate, so they pin
down the cash-flow engine. (The guide's NPV figure, 61.3 m$, uses a yield
curve whose exact observed points are not published, so it is checked live
against the deployed calculator instead.)

Run:  uv run pytest -q
      uv run python test_default_scenario.py   (prints full JSON reference)
"""

import json

from debt_swap_model import (Instrument, NewDebt, SpendingCommitment,
                             run_swap)


def default_scenario(spending: bool = False):
    existing = [
        Instrument(kind="loan", principal=100, rate=0.05, maturity=4,
                   profile="equal", grace=0),
        Instrument(kind="loan", principal=30, rate=0.03, maturity=5,
                   profile="equal", grace=3),
        Instrument(kind="loan", principal=60, rate=0.04, maturity=4,
                   profile="maturity"),
        Instrument(kind="bond", principal=150, rate=0.08, maturity=15,
                   profile="last3", price=80),
    ]
    new = NewDebt(amount=0, rate=0.05, maturity=10, profile="equal",
                  grace=5, upfront_fees=5)
    commit = SpendingCommitment(annual=8, start=1, years=15) if spending \
        else None
    return run_swap(existing, new, spending=commit, flat=0.05, subsidy=30.0)


def test_buyback_cost_matches_wb_auto_amount():
    r = default_scenario()
    # 100 + 30 + 60 at par, bond 150 at price 80 -> 120. Total 310.
    assert abs(r.buyback_cost - 310.0) < 1e-9


def test_nominal_savings_match_user_guide():
    r = default_scenario()
    assert abs(r.nominal_savings_over(1) - 24.8) < 0.05
    assert abs(r.nominal_savings_over(2) - 53.3) < 0.05
    assert abs(r.nominal_savings_over(3) - 80.6) < 0.05
    assert abs(r.nominal_savings_over(5) - 193.6) < 0.05


def test_atm_matches_user_guide():
    r = default_scenario()
    assert abs(r.atm(r.old_service) - 7.1) < 0.05
    assert abs(r.atm(r.new_service) - 6.5) < 0.05


def test_year1_hand_calculation():
    """Hand check: old service in year 1.

    Loan A: 5 interest + 25 principal = 30
    Loan B (grace): 0.9 interest
    Loan C (bullet): 2.4 interest
    Bond: 12 interest
    Total 45.3; new debt (grace): 310 * 5% = 15.5.
    """
    r = default_scenario()
    assert abs(r.old_service[0] - 45.3) < 1e-9
    assert abs(r.new_service[0] - 15.5) < 1e-9


def reference_json() -> str:
    r = default_scenario(spending=True)
    out = {
        "buyback_cost": r.buyback_cost,
        "old_service": [round(x, 6) for x in r.old_service],
        "new_service": [round(x, 6) for x in r.new_service],
        "spending": r.spending,
        "nominal_over": {y: round(r.nominal_savings_over(y), 4)
                         for y in (1, 2, 3, 5)},
        "npv_savings_flat5": round(r.npv_savings, 4),
        "pv_spending": round(r.pv_spending, 4),
        "npv_net_of_spending": round(r.npv_net_of_spending, 4),
        "fiscal_space_by_year": [round(x, 4) for x in
                                 r.fiscal_space_by_year],
        "atm_old": round(r.atm(r.old_service), 4),
        "atm_new": round(r.atm(r.new_service), 4),
        "pv_old_at_5pct": round(r.pv_old_at_discount(), 4),
        "buyback_vs_pv": round(r.buyback_vs_pv(), 4),
        "leverage_at_subsidy_30": round(r.leverage, 4),
    }
    return json.dumps(out, indent=2)


if __name__ == "__main__":
    print(reference_json())
