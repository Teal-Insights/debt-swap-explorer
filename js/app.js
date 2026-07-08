/* Debt Swap Explorer UI. D3 v7. Rendering and input handling only; all
 * finance lives in model.js. Maturities are entered as calendar years and
 * converted to offsets from the current year before hitting the engine. */

(() => {
  const COLORS = {
    ink: "#143E5A", teal: "#0094BC", terracotta: "#B5380C",
    gold: "#C9971F", sage: "#83A39A", slate: "#5C6770", divider: "#D4D0CA",
  };

  /* Default scenario: same terms as the WB Debt Swap Calculator User Guide
   * worked example (offsets from the current year: 4, 5, 4, 15; new debt
   * 10 years with 5 years grace). */
  const defaultInstruments = [
    { kind: "loan", principal: 100, rate: 5, maturity: 2030, profile: "equal", grace: 0, fee: 0, price: 100 },
    { kind: "loan", principal: 30, rate: 3, maturity: 2031, profile: "equal", grace: 3, fee: 0, price: 100 },
    { kind: "loan", principal: 60, rate: 4, maturity: 2030, profile: "maturity", grace: 0, fee: 0, price: 100 },
    { kind: "bond", principal: 150, rate: 8, maturity: 2041, profile: "last3", grace: 0, fee: 0, price: 80 },
  ];
  const defaultYields = [
    { year: 2027, y: 5.5 }, { year: 2031, y: 6.5 }, { year: 2036, y: 7.0 },
    { year: 2041, y: 7.2 }, { year: 2046, y: 7.3 },
  ];

  const personaCopy = {
    mof: "You sit in the Ministry of Finance. The question: does this swap buy real fiscal space when you need it, after honoring the spending commitment, or does it just move the bump in the road?",
    funder: "You are the funder making the new financing cheap. The question: how much long-term, predictable development spending does each dollar of your subsidy unlock, and would a direct grant do better?",
    investor: "You hold the old debt. The question: what is the debtor retiring, at what price, and how does the exit compare with the present value of the promises you are giving up?",
  };

  let currentPersona = "mof";

  /* ---------- existing-debt rows ---------- */
  const instBox = document.getElementById("instruments");

  function instrumentRow(inst) {
    const div = document.createElement("div");
    div.className = "instrument";
    div.innerHTML = `
      <button class="del" title="Remove this instrument">&#10005; remove</button>
      <div class="row c3">
        <div><label>Type</label>
          <select data-f="kind">
            <option value="loan"${inst.kind === "loan" ? " selected" : ""}>Loan</option>
            <option value="bond"${inst.kind === "bond" ? " selected" : ""}>Bond</option>
          </select></div>
        <div><label>Final maturity (year)</label><input data-f="maturity" type="number" value="${inst.maturity}"></div>
        <div><label>Principal (m$)</label><input data-f="principal" type="number" step="1" value="${inst.principal}"></div>
      </div>
      <div class="row c3">
        <div><label>Repayment profile</label>
          <select data-f="profile">
            <option value="equal"${inst.profile === "equal" ? " selected" : ""}>Equal installments</option>
            <option value="maturity"${inst.profile === "maturity" ? " selected" : ""}>At maturity</option>
            <option value="last3"${inst.profile === "last3" ? " selected" : ""}>Last 3 years</option>
          </select></div>
        <div><label>Remaining grace period (yrs)</label><input data-f="grace" type="number" value="${inst.grace}"${inst.kind === "bond" ? " disabled" : ""}></div>
        <div><label>Interest rate (% p.y.)</label><input data-f="rate" type="number" step="0.1" value="${inst.rate}"></div>
      </div>
      <div class="row c2">
        <div><label>Prepayment fee / premium (%)</label><input data-f="fee" type="number" step="0.1" value="${inst.fee}"></div>
        <div><label>Pricing, bonds only (% of par)</label><input data-f="price" type="number" step="1" value="${inst.price}"${inst.kind === "loan" ? " disabled" : ""}></div>
      </div>`;
    div.querySelector(".del").addEventListener("click", () => { div.remove(); recalc(); });
    div.querySelectorAll("input,select").forEach(el => el.addEventListener("change", () => {
      if (el.dataset.f === "kind") {
        div.querySelector('input[data-f="price"]').disabled = el.value === "loan";
        div.querySelector('input[data-f="grace"]').disabled = el.value === "bond";
      }
      recalc();
    }));
    return div;
  }

  defaultInstruments.forEach(inst => instBox.appendChild(instrumentRow(inst)));
  document.getElementById("addInstrument").addEventListener("click", () => {
    const cy = +document.getElementById("curYear").value;
    instBox.appendChild(instrumentRow({ kind: "bond", principal: 50, rate: 7, maturity: cy + 10, profile: "maturity", grace: 0, fee: 0, price: 85 }));
    recalc();
  });

  /* ---------- yield-curve rows ---------- */
  const curveBox = document.getElementById("curvePoints");

  function yieldRow(pt) {
    const div = document.createElement("div");
    div.className = "row c3";
    div.innerHTML = `
      <div><label>Maturity (year)</label><input data-f="year" type="number" value="${pt.year}"></div>
      <div><label>Yield (%)</label><input data-f="y" type="number" step="0.05" value="${pt.y}"></div>
      <div style="align-self:end;"><button class="btn del-yield" title="Remove">&#10005;</button></div>`;
    div.querySelector(".del-yield").addEventListener("click", () => { div.remove(); recalc(); });
    div.querySelectorAll("input").forEach(el => el.addEventListener("change", recalc));
    return div;
  }
  defaultYields.forEach(pt => curveBox.appendChild(yieldRow(pt)));
  document.getElementById("addYield").addEventListener("click", () => {
    if (curveBox.children.length >= 5) return;
    const cy = +document.getElementById("curYear").value;
    curveBox.appendChild(yieldRow({ year: cy + 3, y: 6.0 }));
    recalc();
  });

  /* ---------- read inputs ---------- */
  function readInputs() {
    const cy = Math.round(+document.getElementById("curYear").value) || new Date().getFullYear();
    const off = calYear => Math.max(1, Math.round(calYear) - cy);

    const existing = [...instBox.querySelectorAll(".instrument")].map(div => {
      const g = f => div.querySelector(`[data-f="${f}"]`).value;
      const kind = g("kind");
      return {
        kind,
        principal: +g("principal"), rate: +g("rate") / 100,
        maturity: off(+g("maturity")),
        profile: g("profile"),
        grace: kind === "bond" ? 0 : Math.max(0, Math.round(+g("grace"))),
        fee: +g("fee") / 100,
        price: kind === "loan" ? 100 : +g("price"),
      };
    });

    const approach = document.querySelector('input[name="discApproach"]:checked').value;
    let curve = null;
    if (approach === "curve") {
      curve = [...curveBox.querySelectorAll(".row")].map(div => [
        Math.max(1, Math.round(+div.querySelector('[data-f="year"]').value) - cy),
        +div.querySelector('[data-f="y"]').value / 100,
      ]).filter(p => isFinite(p[0]) && isFinite(p[1]));
      if (!curve.length) curve = null;
    }

    const v = id => +document.getElementById(id).value;
    return {
      cy, approach, existing, curve,
      newDebt: {
        rate: v("nRate") / 100, maturity: off(v("nMat")),
        grace: Math.max(0, Math.round(v("nGrace"))),
        profile: document.getElementById("nProfile").value,
        upfrontFees: v("nFees"),
      },
      commit: { annual: v("cAnnual"), start: off(v("cStart")), years: Math.max(0, Math.round(v("cYears"))) },
      opts: { flat: v("dRate") / 100, subsidy: v("fSubsidy") },
    };
  }

  /* ---------- cards ---------- */
  const fmt = x => (x >= 0 ? "" : "−") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const card = (k, v, s, opts = {}) => `
    <div class="card${opts.hero ? " hero" : ""}">
      <div class="k">${k}</div>
      <div class="v${v < 0 && opts.sign ? " neg" : ""}">${opts.raw ?? fmt(v)}</div>
      <div class="s">${s}</div>
    </div>`;

  function renderCards(r) {
    const el = document.getElementById("cards");
    if (currentPersona === "mof") {
      el.innerHTML =
        card("NPV savings (refinancing)", r.npvSavings, "m$, PV of service savings net of upfront fees", { hero: true, sign: true }) +
        card("PV of commitment", r.pvSpending, "m$, development spending leg", {}) +
        card("Net gain after commitment", r.npvNetOfSpending, "m$, the number that decides it", { hero: true, sign: true }) +
        card("Nominal savings over 3 yrs", r.nominalOver3, "m$, the liquidity view", { sign: true }) +
        card("Maturity extension", r.atmNew - r.atmOld, `yrs (ATM ${r.atmOld.toFixed(1)} → ${r.atmNew.toFixed(1)})`, { sign: true });
    } else if (currentPersona === "funder") {
      el.innerHTML =
        card("Leverage", r.leverage, r.leverage ? "PV of development spend per $ of subsidy" : "enter a subsidy", { hero: true, raw: r.leverage ? r.leverage.toFixed(1) + "×" : "—" }) +
        card("PV of commitment", r.pvSpending, "m$ of long-term, predictable spending", { hero: true }) +
        card("Your subsidy", r.subsidy, "m$, grant element of support", {}) +
        card("Debtor's net gain", r.npvNetOfSpending, "m$, what the country keeps", { sign: true }) +
        card("Commitment horizon", 0, "", { raw: (r.spending.filter(x => x > 0).length) + " yrs" });
    } else {
      el.innerHTML =
        card("Buyback cost", r.buybackCost, "m$ paid to retire old claims", { hero: true }) +
        card("PV of old flows", r.pvOld, "m$ at the chosen discount basis", {}) +
        card("Discount captured", r.buybackVsPv, "m$, PV retired − cash paid", { hero: true, sign: true }) +
        card("New debt issued", r.amount, "m$, funds the buyback", {}) +
        card("ATM of new claim", r.atmNew, "yrs, service-weighted", { raw: r.atmNew.toFixed(1) + " yrs" });
    }
    document.getElementById("personaNote").textContent = personaCopy[currentPersona];
  }

  /* ---------- WB-comparable savings table ---------- */
  function renderSavingsTable(r, rFixed, rCurve, approach) {
    const row = (k, v, note) => `<tr><td>${k}</td><td class="num${v < 0 ? " neg" : ""}">${fmt(v)}</td><td class="note">${note || ""}</td></tr>`;
    let html = `<tr><th>Measure</th><th class="num">m$</th><th></th></tr>`;
    html += row("Nominal savings over 1 year", r.nominalOver1, "net of upfront fees");
    html += row("Nominal savings over 2 years", r.nominalOver2, "");
    html += row("Nominal savings over 3 years", r.nominalOver3, "");
    html += row("Nominal savings over 5 years", r.nominalOver5, "");
    html += row("From maturity extension", r.extensionSavings, "WB heuristic: amount × marginal rate × ATM change; not a cash flow");
    html += row("NPV savings @ fixed rate", rFixed.npvSavings, "mid-year discounting");
    if (rCurve) html += row("NPV savings @ yield curve", rCurve.npvSavings, approach === "curve" ? "basis in use" : "");
    html += `<tr><td>Average time to maturity</td><td class="num">${r.atmOld.toFixed(1)} → ${r.atmNew.toFixed(1)}</td><td class="note">years, debt-service-weighted; extension ${fmt(r.atmNew - r.atmOld)}</td></tr>`;
    document.getElementById("savingsTable").innerHTML = html;
  }

  /* ---------- charts ---------- */
  function chartDims(svgEl, h) {
    const w = svgEl.node().clientWidth || 700;
    svgEl.attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio", "xMidYMid meet");
    return { w, h, m: { t: 12, r: 14, b: 28, l: 44 } };
  }
  const yearTicks = (years, cy) => years.filter(t => (cy + t) % 2 === 0);

  function renderChart1(r, cy) {
    document.getElementById("c1title").textContent =
      "Debt service falls now and rises later; the spending commitment fills the trough";
    document.getElementById("c1sub").textContent =
      "m$ per year. Old debt service (gray, dashed), new debt service (teal), committed development spending (gold bars).";
    const svg = d3.select("#chart1");
    svg.selectAll("*").remove();
    const { w, h, m } = chartDims(svg, 300);
    const years = d3.range(1, r.horizon + 1);
    const x = d3.scaleBand().domain(years).range([m.l, w - m.r]).padding(0.25);
    const ymax = d3.max([...r.oldService, ...r.newService, ...r.spending]) * 1.08;
    const y = d3.scaleLinear().domain([0, ymax]).nice().range([h - m.b, m.t]);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
      .call(d3.axisBottom(x).tickValues(yearTicks(years, cy)).tickFormat(t => cy + t));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5));

    svg.selectAll(".spend").data(years).join("rect")
      .attr("x", t => x(t)).attr("width", x.bandwidth())
      .attr("y", t => y(r.spending[t - 1])).attr("height", t => y(0) - y(r.spending[t - 1]))
      .attr("fill", COLORS.gold).attr("opacity", 0.55);

    const line = acc => d3.line().x(t => x(t) + x.bandwidth() / 2).y(t => y(acc(t)));
    svg.append("path").datum(years).attr("d", line(t => r.oldService[t - 1]))
      .attr("fill", "none").attr("stroke", COLORS.slate).attr("stroke-width", 2).attr("stroke-dasharray", "5,3");
    svg.append("path").datum(years).attr("d", line(t => r.newService[t - 1]))
      .attr("fill", "none").attr("stroke", COLORS.teal).attr("stroke-width", 2.5);

    const leg = svg.append("g").attr("transform", `translate(${w - m.r - 210},${m.t + 2})`);
    const item = (dy, color, label, dash) => {
      leg.append("line").attr("x1", 0).attr("x2", 22).attr("y1", dy).attr("y2", dy)
        .attr("stroke", color).attr("stroke-width", 2.5).attr("stroke-dasharray", dash || null);
      leg.append("text").attr("class", "legend").attr("x", 28).attr("y", dy + 4).text(label);
    };
    item(0, COLORS.slate, "Old debt service", "5,3");
    item(16, COLORS.teal, "New debt service");
    leg.append("rect").attr("x", 4).attr("y", 26).attr("width", 14).attr("height", 10).attr("fill", COLORS.gold).attr("opacity", .55);
    leg.append("text").attr("class", "legend").attr("x", 28).attr("y", 35).text("Development spending");
  }

  function renderChart2(r, cy) {
    document.getElementById("c2title").textContent =
      "Net fiscal space, year by year: savings minus the commitment";
    document.getElementById("c2sub").textContent =
      "m$ per year: old service − new service − committed spending. Teal = space created, terracotta = squeeze.";
    const svg = d3.select("#chart2");
    svg.selectAll("*").remove();
    const { w, h, m } = chartDims(svg, 280);
    const years = d3.range(1, r.horizon + 1);

    const x = d3.scaleBand().domain(years).range([m.l, w - m.r]).padding(0.25);
    const yext = d3.extent([...r.fiscalSpace, 0]);
    const y = d3.scaleLinear().domain([Math.min(yext[0], 0) * 1.08, Math.max(yext[1], 0) * 1.08]).nice().range([h - m.b, m.t]);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
      .call(d3.axisBottom(x).tickValues(yearTicks(years, cy)).tickFormat(t => cy + t));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5));

    svg.selectAll(".fs").data(years).join("rect")
      .attr("x", t => x(t)).attr("width", x.bandwidth())
      .attr("y", t => Math.min(y(0), y(r.fiscalSpace[t - 1])))
      .attr("height", t => Math.abs(y(0) - y(r.fiscalSpace[t - 1])))
      .attr("fill", t => r.fiscalSpace[t - 1] >= 0 ? COLORS.teal : COLORS.terracotta)
      .attr("opacity", 0.8);
    svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0))
      .attr("stroke", COLORS.slate).attr("stroke-width", 1);
  }

  function renderChart3(curve, horizon, cy) {
    const panel = document.getElementById("curveChartPanel");
    if (!curve) { panel.style.display = "none"; return; }
    panel.style.display = "";
    const svg = d3.select("#chart3");
    svg.selectAll("*").remove();
    const { w, h, m } = chartDims(svg, 240);
    const maxD = Math.max(horizon, ...curve.map(p => p[0]));
    const ds = d3.range(1, maxD + 1);
    const ys = ds.map(d => SwapModel.interpYield(curve, d) * 100);

    const x = d3.scaleLinear().domain([1, maxD]).range([m.l, w - m.r]);
    const y = d3.scaleLinear().domain(d3.extent([...ys, ...curve.map(p => p[1] * 100)])).nice().range([h - m.b, m.t]);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d => cy + d));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(v => v + "%"));

    svg.append("path").datum(ds)
      .attr("d", d3.line().x(d => x(d)).y((d, i) => y(ys[i])))
      .attr("fill", "none").attr("stroke", COLORS.sage).attr("stroke-width", 2);
    svg.selectAll(".obs").data(curve).join("circle")
      .attr("cx", p => x(p[0])).attr("cy", p => y(p[1] * 100)).attr("r", 4.5)
      .attr("fill", COLORS.teal);
  }

  /* ---------- CSV export ---------- */
  function exportCsv(r, cy, approach) {
    const lines = [];
    lines.push("Debt Swap Explorer export,Teal Insights,https://teal-insights.github.io/debt-swap-explorer/");
    lines.push(`Current year,${cy},Discount basis,${approach === "curve" ? "yield curve" : "fixed rate"}`);
    lines.push("");
    lines.push("Year,Old debt service (m$),New debt service (m$),Nominal savings (m$),Committed spending (m$),Net fiscal space (m$),Discount factor,PV of savings (m$)");
    for (let t = 1; t <= r.horizon; t++) {
      lines.push([cy + t, r.oldService[t - 1], r.newService[t - 1], r.savingsByYear[t - 1],
        r.spending[t - 1], r.fiscalSpace[t - 1], r.dfs[t - 1],
        r.savingsByYear[t - 1] * r.dfs[t - 1]].map(x => (+x).toFixed(4)).join(","));
    }
    lines.push("");
    lines.push("Summary,m$");
    lines.push(`Buyback cost / new debt amount,${r.buybackCost.toFixed(2)}`);
    lines.push(`Upfront fees,${r.fees.toFixed(2)}`);
    lines.push(`Nominal savings over 1y,${r.nominalOver1.toFixed(2)}`);
    lines.push(`Nominal savings over 2y,${r.nominalOver2.toFixed(2)}`);
    lines.push(`Nominal savings over 3y,${r.nominalOver3.toFixed(2)}`);
    lines.push(`Nominal savings over 5y,${r.nominalOver5.toFixed(2)}`);
    lines.push(`Savings from maturity extension (WB heuristic),${r.extensionSavings.toFixed(2)}`);
    lines.push(`NPV savings,${r.npvSavings.toFixed(2)}`);
    lines.push(`PV of development commitment,${r.pvSpending.toFixed(2)}`);
    lines.push(`Net NPV gain after commitment,${r.npvNetOfSpending.toFixed(2)}`);
    lines.push(`ATM old (yrs),${r.atmOld.toFixed(2)}`);
    lines.push(`ATM new (yrs),${r.atmNew.toFixed(2)}`);
    lines.push(`PV of old flows,${r.pvOld.toFixed(2)}`);
    lines.push(`Discount captured (PV old - buyback),${r.buybackVsPv.toFixed(2)}`);
    lines.push(`Funder subsidy,${r.subsidy.toFixed(2)}`);
    if (r.leverage) lines.push(`Funder leverage (PV commitment / subsidy),${r.leverage.toFixed(2)}`);

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `debt-swap-explorer_${cy}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- main ---------- */
  let lastResult = null, lastCy = null, lastApproach = "fixed";

  function recalc() {
    const { cy, approach, existing, curve, newDebt, commit, opts } = readInputs();
    if (!existing.length) return;

    const rFixed = SwapModel.run(existing, { ...newDebt }, commit, { flat: opts.flat, subsidy: opts.subsidy });
    const rCurve = curve ? SwapModel.run(existing, { ...newDebt }, commit, { curve, subsidy: opts.subsidy }) : null;
    const r = (approach === "curve" && rCurve) ? rCurve : rFixed;

    lastResult = r; lastCy = cy; lastApproach = approach;
    renderCards(r);
    renderSavingsTable(r, rFixed, rCurve, approach);
    renderChart1(r, cy);
    renderChart2(r, cy);
    renderChart3(approach === "curve" ? curve : null, r.horizon, cy);
  }

  document.getElementById("calc").addEventListener("click", recalc);
  document.getElementById("exportBtn").addEventListener("click", () => {
    if (lastResult) exportCsv(lastResult, lastCy, lastApproach);
  });
  ["curYear", "nRate", "nMat", "nGrace", "nProfile", "nFees", "cAnnual", "cStart", "cYears", "fSubsidy", "dRate"]
    .forEach(id => document.getElementById(id).addEventListener("change", recalc));
  document.querySelectorAll('input[name="discApproach"]').forEach(el => el.addEventListener("change", () => {
    document.getElementById("curveBox").style.display = el.value === "curve" && el.checked ? "" : "none";
    document.getElementById("fixedRateBox").style.display = el.value === "curve" && el.checked ? "none" : "";
    recalc();
  }));
  document.querySelectorAll(".persona-btn").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".persona-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    currentPersona = b.dataset.p;
    recalc();
  }));
  window.addEventListener("resize", recalc);

  swapModelSelfCheck();
  recalc();
})();
