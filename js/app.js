/* Debt Swap Explorer UI. D3 v7. Rendering only; all finance lives in model.js. */

(() => {
  const COLORS = {
    ink: "#143E5A", teal: "#0094BC", terracotta: "#B5380C",
    gold: "#C9971F", sage: "#83A39A", slate: "#5C6770", divider: "#D4D0CA",
  };

  /* Default scenario = WB Debt Swap Calculator User Guide worked example. */
  const defaultInstruments = [
    { kind: "loan", principal: 100, rate: 5, maturity: 4, profile: "equal", grace: 0, fee: 0, price: 100 },
    { kind: "loan", principal: 30, rate: 3, maturity: 5, profile: "equal", grace: 3, fee: 0, price: 100 },
    { kind: "loan", principal: 60, rate: 4, maturity: 4, profile: "maturity", grace: 0, fee: 0, price: 100 },
    { kind: "bond", principal: 150, rate: 8, maturity: 15, profile: "last3", grace: 0, fee: 0, price: 80 },
  ];

  const personaCopy = {
    mof: "You sit in the Ministry of Finance. The question: does this swap buy real fiscal space when you need it, after honoring the spending commitment, or does it just move the bump in the road?",
    funder: "You are the funder making the new financing cheap. The question: how much long-term, predictable development spending does each dollar of your subsidy unlock, and would a direct grant do better?",
    investor: "You hold the old debt. The question: what is the debtor retiring, at what price, and how does the exit compare with the present value of the promises you are giving up?",
  };

  let currentPersona = "mof";

  /* ---------- input rendering ---------- */
  const instBox = document.getElementById("instruments");

  function instrumentRow(inst, idx) {
    const div = document.createElement("div");
    div.className = "instrument";
    div.innerHTML = `
      <button class="del" title="Remove">&#10005; remove</button>
      <div class="row c3">
        <div><label>Type</label>
          <select data-f="kind">
            <option value="loan"${inst.kind === "loan" ? " selected" : ""}>Loan</option>
            <option value="bond"${inst.kind === "bond" ? " selected" : ""}>Bond</option>
          </select></div>
        <div><label>Principal (m$)</label><input data-f="principal" type="number" step="1" value="${inst.principal}"></div>
        <div><label>Rate (%)</label><input data-f="rate" type="number" step="0.1" value="${inst.rate}"></div>
      </div>
      <div class="row c3">
        <div><label>Maturity (yrs)</label><input data-f="maturity" type="number" value="${inst.maturity}"></div>
        <div><label>Profile</label>
          <select data-f="profile">
            <option value="equal"${inst.profile === "equal" ? " selected" : ""}>Equal</option>
            <option value="maturity"${inst.profile === "maturity" ? " selected" : ""}>At maturity</option>
            <option value="last3"${inst.profile === "last3" ? " selected" : ""}>Last 3 yrs</option>
          </select></div>
        <div><label>Grace (yrs)</label><input data-f="grace" type="number" value="${inst.grace}"></div>
      </div>
      <div class="row c2">
        <div><label>Fee / premium (%)</label><input data-f="fee" type="number" step="0.1" value="${inst.fee}"></div>
        <div><label>Price, bonds (% par)</label><input data-f="price" type="number" step="1" value="${inst.price}"${inst.kind === "loan" ? " disabled" : ""}></div>
      </div>`;
    div.querySelector(".del").addEventListener("click", () => { div.remove(); recalc(); });
    div.querySelectorAll("input,select").forEach(el => el.addEventListener("change", () => {
      if (el.dataset.f === "kind") {
        div.querySelector('input[data-f="price"]').disabled = el.value === "loan";
      }
      recalc();
    }));
    return div;
  }

  defaultInstruments.forEach((inst, i) => instBox.appendChild(instrumentRow(inst, i)));
  document.getElementById("addInstrument").addEventListener("click", () => {
    instBox.appendChild(instrumentRow({ kind: "bond", principal: 50, rate: 7, maturity: 10, profile: "maturity", grace: 0, fee: 0, price: 85 }));
    recalc();
  });

  function readInputs() {
    const existing = [...instBox.querySelectorAll(".instrument")].map(div => {
      const g = f => div.querySelector(`[data-f="${f}"]`).value;
      const kind = g("kind");
      return {
        kind,
        principal: +g("principal"), rate: +g("rate") / 100,
        maturity: Math.max(1, Math.round(+g("maturity"))),
        profile: g("profile"),
        grace: kind === "bond" ? 0 : Math.max(0, Math.round(+g("grace"))),
        fee: +g("fee") / 100,
        price: kind === "loan" ? 100 : +g("price"),
      };
    });
    const v = id => +document.getElementById(id).value;
    return {
      existing,
      newDebt: {
        rate: v("nRate") / 100, maturity: Math.max(1, Math.round(v("nMat"))),
        grace: Math.max(0, Math.round(v("nGrace"))),
        profile: document.getElementById("nProfile").value,
        upfrontFees: v("nFees"),
      },
      commit: { annual: v("cAnnual"), start: Math.max(1, Math.round(v("cStart"))), years: Math.max(0, Math.round(v("cYears"))) },
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
        card("NPV savings (refinancing)", r.npvSavings, "m$, PV of service savings − fees", { hero: true, sign: true }) +
        card("PV of commitment", r.pvSpending, "m$, development spending leg", {}) +
        card("Net gain after commitment", r.npvNetOfSpending, "m$, the number that decides it", { hero: true, sign: true }) +
        card("Savings over 3 yrs", r.nominalOver3, "m$ nominal, the liquidity view", { sign: true }) +
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
        card("PV of old flows", r.pvOld, "m$ at the chosen discount rate", {}) +
        card("Discount captured", r.buybackVsPv, "m$, PV retired − cash paid", { hero: true, sign: true }) +
        card("New debt issued", r.amount, "m$, funds the buyback", {}) +
        card("ATM of new claim", r.atmNew, "yrs, service-weighted", { raw: r.atmNew.toFixed(1) + " yrs" });
    }
    document.getElementById("personaNote").textContent = personaCopy[currentPersona];
  }

  /* ---------- charts ---------- */
  function chartDims(svgEl, h) {
    const w = svgEl.node().clientWidth || 700;
    svgEl.attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio", "xMidYMid meet");
    return { w, h, m: { t: 12, r: 14, b: 28, l: 44 } };
  }

  function renderChart1(r) {
    document.getElementById("c1title").textContent =
      "Debt service falls now, rises later — the spending commitment fills the trough";
    document.getElementById("c1sub").textContent =
      "m$ per year. Old debt service (gray), new debt service (teal), committed development spending (gold bars).";
    const svg = d3.select("#chart1");
    svg.selectAll("*").remove();
    const { w, h, m } = chartDims(svg, 300);
    const years = d3.range(1, r.horizon + 1);
    const x = d3.scaleBand().domain(years).range([m.l, w - m.r]).padding(0.25);
    const ymax = d3.max([...r.oldService, ...r.newService, ...r.spending]) * 1.08;
    const y = d3.scaleLinear().domain([0, ymax]).nice().range([h - m.b, m.t]);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
      .call(d3.axisBottom(x).tickValues(years.filter(t => t % 2 === 1)).tickFormat(t => "yr " + t));
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
    leg.append("rect").attr("x", 4, 0).attr("y", 26).attr("width", 14).attr("height", 10).attr("fill", COLORS.gold).attr("opacity", .55);
    leg.append("text").attr("class", "legend").attr("x", 28).attr("y", 35).text("Development spending");
  }

  function renderChart2(r) {
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
      .call(d3.axisBottom(x).tickValues(years.filter(t => t % 2 === 1)).tickFormat(t => "yr " + t));
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

  /* ---------- main ---------- */
  function recalc() {
    const { existing, newDebt, commit, opts } = readInputs();
    if (!existing.length) return;
    const r = SwapModel.run(existing, newDebt, commit, opts);
    renderCards(r);
    renderChart1(r);
    renderChart2(r);
  }

  document.getElementById("calc").addEventListener("click", recalc);
  ["nRate", "nMat", "nGrace", "nProfile", "nFees", "cAnnual", "cStart", "cYears", "fSubsidy", "dRate"]
    .forEach(id => document.getElementById(id).addEventListener("change", recalc));
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
