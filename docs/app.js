(() => {
  "use strict";

  const CREDIT_USD = 0.01;
  const TOP_N = 5;
  const THEME_KEY = "copilot-usage-theme";

  const SERIES_COLORS = [
    "var(--series-1)",
    "var(--series-2)",
    "var(--series-3)",
    "var(--series-4)",
    "var(--series-5)",
  ];
  const SERIES_DASHES = [
    [],
    [7, 4],
    [1.5, 3],
    [9, 3, 2, 3],
    [3, 3],
  ];
  const OTHER_COLOR = "var(--series-other)";
  const OTHER_DASH = [1.5, 3];

  const state = {
    report: null,
    groupBy: "models",
    filter: "",
    chart: null,
    hiddenSeries: new Set(),
    openRows: new Set(),
  };

  const els = {
    themeToggle: document.getElementById("theme-toggle"),
    filterInput: document.getElementById("filter-input"),
    groupBySelect: document.getElementById("groupby-select"),
    creditsUsed: document.getElementById("credits-used"),
    creditsTotal: document.getElementById("credits-total"),
    progressBar: document.getElementById("progress-bar"),
    creditsCaption: document.getElementById("credits-caption"),
    chartTitle: document.getElementById("chart-title"),
    chartSubtitle: document.getElementById("chart-subtitle"),
    chartLegend: document.getElementById("chart-legend"),
    chartCanvas: document.getElementById("usage-chart"),
    chartEmpty: document.getElementById("chart-empty"),
    breakdownSubtitle: document.getElementById("breakdown-subtitle"),
    breakdownHead: document.getElementById("breakdown-head"),
    breakdownBody: document.getElementById("breakdown-body"),
    breakdownEmpty: document.getElementById("breakdown-empty"),
    loadError: document.getElementById("load-error"),
  };

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(theme);

    els.themeToggle.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
      if (state.chart) {
        renderChart();
      }
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    els.themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    els.themeToggle.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
    );
  }

  function cssVar(name) {
    const match = /^var\((--[\w-]+)\)$/.exec(name);
    if (!match) return name;
    return getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  }

  function formatCredits(value) {
    return (Number.isFinite(value) ? value : 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatWholeCredits(value) {
    return Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US");
  }

  function formatUsd(value) {
    return (Number.isFinite(value) ? value : 0).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  }

  function formatShortDay(isoDay) {
    const [year, month, day] = isoDay.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  function formatLongDate(date) {
    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  function formatPercentage(value) {
    return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
  }

  function monthBounds(period) {
    const firstDay = new Date(Date.UTC(period.year, period.month - 1, 1));
    const lastDay = new Date(Date.UTC(period.year, period.month, 0));
    const resetDay = new Date(Date.UTC(period.year, period.month, 1));
    return { firstDay, lastDay, resetDay };
  }

  function matchesFilter(text) {
    if (!state.filter) return true;
    return String(text || "").toLowerCase().includes(state.filter);
  }

  function initialsFor(login) {
    return String(login || "?").slice(0, 1).toUpperCase();
  }

  function chevronIcon() {
    return `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">` +
      `<path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path>` +
      `</svg>`;
  }

  function avatarNode(user) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.alt = "";
    img.width = 20;
    img.height = 20;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = `https://github.com/${encodeURIComponent(user.userLogin)}.png?size=40`;
    img.addEventListener(
      "error",
      () => {
        const fallback = document.createElement("span");
        fallback.className = "avatar avatar-fallback";
        fallback.textContent = initialsFor(user.userLogin);
        img.replaceWith(fallback);
      },
      { once: true },
    );
    return img;
  }

  async function loadReport() {
    try {
      const response = await fetch("./data.json", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      state.report = await response.json();
      if (!state.report.userMetrics) {
        const usersOption = els.groupBySelect.querySelector('option[value="users"]');
        if (usersOption) usersOption.disabled = true;
      }
      renderAll();
    } catch (error) {
      els.loadError.hidden = false;
      els.loadError.textContent = `Couldn't load usage data: ${error.message}`;
    }
  }

  function renderAll() {
    renderCredits();
    renderChart();
    renderTable();
  }

  function totalCreditsPool(limits) {
    const budgeted = (limits.aiCreditBudgets ?? []).reduce(
      (sum, budget) => sum + (budget.equivalentCredits ?? 0),
      0,
    );
    return limits.includedCredits + budgeted;
  }

  function renderCredits() {
    const { credits, limits, period, generatedAt } = state.report;
    const total = totalCreditsPool(limits);
    const percentUsed = total > 0 ? (credits.grossUsed / total) * 100 : 0;

    els.creditsUsed.textContent = formatWholeCredits(credits.grossUsed);
    els.creditsTotal.textContent = formatWholeCredits(total);
    els.progressBar.style.width = `${Math.max(0, Math.min(100, percentUsed))}%`;

    const { resetDay } = monthBounds(period);
    const now = generatedAt ? new Date(generatedAt) : new Date();
    const daysRemaining = Math.max(
      0,
      Math.ceil((resetDay.getTime() - now.getTime()) / 86_400_000),
    );
    els.creditsCaption.textContent =
      `AI credits consumed by Copilot users in your account, including any additional budget. ` +
      `Monthly limit resets in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} on ${formatLongDate(resetDay)}.`;
  }

  function periodLabel() {
    const { firstDay, lastDay } = monthBounds(state.report.period);
    return `${formatShortDay(firstDay.toISOString().slice(0, 10))} - ${formatShortDay(lastDay.toISOString().slice(0, 10))}, ${lastDay.getUTCFullYear()}`;
  }

  // --- Chart -----------------------------------------------------------

  function buildModelSeries() {
    const models = state.report.models.filter((m) => matchesFilter(m.model));
    const sorted = [...models].sort((a, b) => b.grossCredits - a.grossCredits);
    const top = sorted.slice(0, TOP_N);
    const rest = sorted.slice(TOP_N);
    const topNames = new Set(top.map((m) => m.model));
    const restNames = new Set(rest.map((m) => m.model));

    const days = state.report.dailyUsage.days;
    const byModel = state.report.dailyUsage.byModel;
    const series = top.map((m) => ({ key: m.model, label: m.model, values: [] }));
    if (rest.length > 0) {
      series.push({ key: "__other__", label: "All other", values: [] });
    }

    for (const day of days) {
      const entry = byModel.find((e) => e.day === day);
      const perModel = new Map((entry?.models ?? []).map((m) => [m.model, m.grossCredits]));
      let otherTotal = 0;
      for (const [name, credits] of perModel.entries()) {
        if (restNames.has(name)) otherTotal += credits;
      }
      for (const s of series) {
        if (s.key === "__other__") {
          s.values.push(otherTotal * CREDIT_USD);
        } else {
          s.values.push((perModel.get(s.key) ?? 0) * CREDIT_USD);
        }
      }
    }

    return { days, series };
  }

  function buildUserSeries() {
    const users = (state.report.userMetrics?.users ?? []).filter((u) =>
      matchesFilter(u.userLogin),
    );
    const sorted = [...users].sort((a, b) => b.aiCreditsUsed - a.aiCreditsUsed);
    const top = sorted.slice(0, TOP_N);
    const rest = sorted.slice(TOP_N);
    const restIds = new Set(rest.map((u) => String(u.userId)));

    const days = state.report.dailyUsage.days;
    const byUser = state.report.dailyUsage.byUser ?? [];
    const series = top.map((u) => ({ key: String(u.userId), label: u.userLogin, values: [] }));
    if (rest.length > 0) {
      series.push({ key: "__other__", label: "All other", values: [] });
    }

    for (const day of days) {
      const entry = byUser.find((e) => e.day === day);
      const perUser = new Map((entry?.users ?? []).map((u) => [String(u.userId), u.aiCreditsUsed]));
      let otherTotal = 0;
      for (const [id, credits] of perUser.entries()) {
        if (restIds.has(id)) otherTotal += credits;
      }
      for (const s of series) {
        if (s.key === "__other__") {
          s.values.push(otherTotal * CREDIT_USD);
        } else {
          s.values.push((perUser.get(s.key) ?? 0) * CREDIT_USD);
        }
      }
    }

    return { days, series };
  }

  function renderChart() {
    els.chartTitle.textContent = `Usage grouped by ${state.groupBy}`;
    els.chartSubtitle.textContent = periodLabel();

    const { days, series } =
      state.groupBy === "users" ? buildUserSeries() : buildModelSeries();
    const hasData = days.length > 0 && series.some((s) => s.values.some((v) => v > 0));

    els.chartEmpty.hidden = hasData;
    els.chartCanvas.parentElement.classList.toggle("is-empty", !hasData);

    renderLegend(series);

    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    if (!hasData) return;

    const labels = days.map(formatShortDay);
    const datasets = series.map((s, index) => {
      const isOther = s.key === "__other__";
      const color = cssVar(isOther ? OTHER_COLOR : SERIES_COLORS[index]);
      return {
        label: s.label,
        data: s.values,
        borderColor: color,
        backgroundColor: color,
        borderDash: isOther ? OTHER_DASH : SERIES_DASHES[index],
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0,
        fill: false,
        hidden: state.hiddenSeries.has(s.key),
      };
    });

    const gridColor = cssVar("var(--chart-grid)");
    const axisColor = cssVar("var(--chart-muted)");

    state.chart = new Chart(els.chartCanvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: axisColor, maxRotation: 0, autoSkip: true },
          },
          y: {
            beginAtZero: true,
            grid: { color: gridColor },
            border: { display: false },
            ticks: {
              color: axisColor,
              callback: (value) => `$${value}`,
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => ` ${item.dataset.label}: ${formatUsd(item.parsed.y)}`,
            },
          },
        },
      },
    });
  }

  function renderLegend(series) {
    els.chartLegend.innerHTML = "";
    series.forEach((s, index) => {
      const isOther = s.key === "__other__";
      const color = cssVar(isOther ? OTHER_COLOR : SERIES_COLORS[index]);
      const dash = isOther ? OTHER_DASH : SERIES_DASHES[index];

      const button = document.createElement("button");
      button.type = "button";
      button.className = "legend-item";
      if (state.hiddenSeries.has(s.key)) button.classList.add("is-hidden");

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.borderTopColor = color;
      swatch.style.borderTopStyle = dash.length === 0 ? "solid" : "dashed";

      const label = document.createElement("span");
      label.textContent = s.label;

      button.append(swatch, label);
      button.addEventListener("click", () => {
        if (state.hiddenSeries.has(s.key)) {
          state.hiddenSeries.delete(s.key);
        } else {
          state.hiddenSeries.add(s.key);
        }
        renderChart();
      });

      els.chartLegend.appendChild(button);
    });
  }

  // --- Breakdown table ---------------------------------------------------

  const COLUMN_LABELS = ["Credits used", "Gross amount", "Percentage"];

  function renderTableHead() {
    els.breakdownHead.innerHTML = "";
    const first = document.createElement("th");
    first.textContent = state.groupBy === "users" ? "User" : "Model";
    els.breakdownHead.appendChild(first);
    for (const label of COLUMN_LABELS) {
      const th = document.createElement("th");
      th.textContent = label;
      els.breakdownHead.appendChild(th);
    }
  }

  function creditCells(row) {
    return [
      formatCredits(row.grossCredits ?? 0),
      formatUsd((row.grossCredits ?? 0) * CREDIT_USD),
      formatPercentage(row.percentageOfGrossCredits ?? 0),
    ];
  }

  function appendRow(nameCell, values, { subrow = false } = {}) {
    const tr = document.createElement("tr");
    if (subrow) tr.classList.add("model-subrow");

    const nameTd = document.createElement("td");
    nameTd.appendChild(nameCell);
    tr.appendChild(nameTd);

    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    els.breakdownBody.appendChild(tr);
    return tr;
  }

  function renderModelsTable() {
    const models = state.report.models.filter((m) => matchesFilter(m.model));
    for (const model of models) {
      const nameWrap = document.createElement("span");
      nameWrap.className = "row-name";
      nameWrap.innerHTML = `<span class="expand-spacer"></span><span>${escapeHtml(model.model)}</span>`;
      appendRow(nameWrap, creditCells(model));
    }
    return models.length;
  }

  function renderUsersTable() {
    const users = (state.report.userMetrics?.users ?? []).filter((u) =>
      matchesFilter(u.userLogin),
    );

    for (const user of users) {
      const rowKey = String(user.userId);
      const modelRows = user.billingCredits?.models ?? [];
      const canExpand = modelRows.length > 0;

      const nameWrap = document.createElement("span");
      nameWrap.className = "row-name";

      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "expand-btn";
      expandBtn.setAttribute("aria-hidden", "true");
      expandBtn.tabIndex = -1;
      expandBtn.innerHTML = chevronIcon();
      if (state.openRows.has(rowKey)) expandBtn.classList.add("is-open");
      if (!canExpand) expandBtn.style.visibility = "hidden";

      const login = document.createElement("a");
      login.className = "user-link";
      login.href = `https://github.com/${encodeURIComponent(user.userLogin)}`;
      login.target = "_blank";
      login.rel = "noopener noreferrer";
      login.textContent = user.userLogin;
      login.addEventListener("click", (event) => event.stopPropagation());

      nameWrap.append(expandBtn, avatarNode(user), login);

      const billing = user.billingCredits ?? {};
      const orgTotal = state.report.credits.grossUsed;
      const userPercentage = orgTotal > 0 ? ((billing.grossUsed ?? 0) / orgTotal) * 100 : 0;
      const userRow = appendRow(nameWrap, [
        formatCredits(billing.grossUsed ?? 0),
        formatUsd(billing.grossValueUsd ?? 0),
        formatPercentage(userPercentage),
      ]);

      const subRows = [];
      for (const model of modelRows) {
        const modelNameWrap = document.createElement("span");
        modelNameWrap.textContent = model.model;
        const subRow = appendRow(modelNameWrap, creditCells(model), { subrow: true });
        subRow.hidden = !state.openRows.has(rowKey);
        subRows.push(subRow);
      }

      if (canExpand) {
        userRow.classList.add("expandable-row");
        userRow.tabIndex = 0;
        userRow.setAttribute("role", "button");
        userRow.setAttribute("aria-label", `Toggle model breakdown for ${user.userLogin}`);
        userRow.setAttribute("aria-expanded", state.openRows.has(rowKey) ? "true" : "false");

        const toggle = () => {
          const willOpen = !state.openRows.has(rowKey);
          if (willOpen) {
            state.openRows.add(rowKey);
          } else {
            state.openRows.delete(rowKey);
          }
          expandBtn.classList.toggle("is-open", willOpen);
          userRow.setAttribute("aria-expanded", willOpen ? "true" : "false");
          subRows.forEach((row) => {
            row.hidden = !willOpen;
          });
        };

        userRow.addEventListener("click", toggle);
        userRow.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        });
      }
    }
    return users.length;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }

  function renderTable() {
    renderTableHead();
    els.breakdownBody.innerHTML = "";

    const { firstDay, lastDay } = monthBounds(state.report.period);
    els.breakdownSubtitle.textContent =
      `Usage for ${formatShortDay(firstDay.toISOString().slice(0, 10))} - ` +
      `${formatShortDay(lastDay.toISOString().slice(0, 10))}, ${lastDay.getUTCFullYear()}. ` +
      `Each AI credit costs $0.01.`;

    const count = state.groupBy === "users" ? renderUsersTable() : renderModelsTable();
    els.breakdownEmpty.hidden = count > 0;
  }

  // --- Wiring -------------------------------------------------------------

  function initControls() {
    state.groupBy = els.groupBySelect.value;

    els.groupBySelect.addEventListener("change", () => {
      state.groupBy = els.groupBySelect.value;
      state.hiddenSeries.clear();
      renderChart();
      renderTable();
    });

    let filterTimer = null;
    els.filterInput.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        state.filter = els.filterInput.value.trim().toLowerCase();
        renderChart();
        renderTable();
      }, 120);
    });
  }

  initTheme();
  initControls();
  loadReport();
})();
