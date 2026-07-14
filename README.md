# Debt Swap Explorer

Interactive cash-flow analysis of debt-for-development swaps, from three seats
at the table: the Ministry of Finance, the funder, and the investor.

Live site: https://teal-insights.github.io/debt-swap-explorer/

> **Research preview.** This tool is in an early design-feedback phase: we want
> to learn which inputs, views, and outputs are actually useful to people who
> work on debt swaps. The calculations follow the World Bank calculator's
> published conventions but have not yet been through thorough independent
> verification, so please treat results as indicative and directional, not
> deal-ready. Feedback is very welcome: lte@tealinsights.com.

## What it is

A static D3 app that reimplements the World Bank Debt Swap Calculator's
refinancing engine from first principles, validates it against the published
User Guide example (Rivetti & Mihalyi, July 2025), and extends it with the
legs a transaction decision needs:

- the development spending commitment as an explicit cash flow (net fiscal
  space by year, NPV net of the commitment)
- a funder lens (PV of committed spending per dollar of subsidy)
- an investor / market-consistency lens (PV of retired flows vs. cash paid)

See `methodology.html` for exactly what it does and does not do.

## Repo layout

- `index.html`, `js/app.js` — the UI (D3 v7, no build step)
- `js/model.js` — the cash-flow engine (mirrors the Python reference)
- `model/` — the Python reference implementation, managed with uv
- `methodology.html` — methods, sources, and honest limitations

## Development

The Python model is the source of truth. To run its tests:

```
cd model
uv run pytest -q
uv run python test_default_scenario.py   # prints the reference JSON
```

`js/model.js` must produce identical numbers; the browser console logs a
self-check against the Python reference on every page load.

## Status

Research preview built in a day (July 2026). Feedback: lte@tealinsights.com
