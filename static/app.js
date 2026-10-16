(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const SVG = 'http://www.w3.org/2000/svg';
  const form = $('#loanForm');
  const panel = $('#result');
  const tooltip = $('#tooltip');
  const insights = JSON.parse($('#insightsData').textContent);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  const pct = (p) => Math.round(p * 100) + '%';

  // ---------- API (the static preview swaps this for an in-browser model) ----------
  async function post(url, body, signal) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Something went wrong');
    return out;
  }
  const API = window.LoanAPI || {
    predict: (d, signal) => post('/api/predict', d, signal),
    landscape: (d, signal) => post('/api/landscape', d, signal),
  };

  const PRESETS = {
    strong:     { Credit_History: '1', ApplicantIncome: 9000, CoapplicantIncome: 3000, LoanAmount: 140, Loan_Amount_Term: '360', Property_Area: 'Semiurban', Dependents: '0', Education: 'Graduate', Married: 'Yes', Self_Employed: 'No', Gender: 'Male' },
    borderline: { Credit_History: '1', ApplicantIncome: 3000, CoapplicantIncome: 800, LoanAmount: 160, Loan_Amount_Term: '360', Property_Area: 'Rural', Dependents: '1', Education: 'Not Graduate', Married: 'No', Self_Employed: 'Yes', Gender: 'Female' },
    risky:      { Credit_History: '0', ApplicantIncome: 3500, CoapplicantIncome: 0, LoanAmount: 200, Loan_Amount_Term: '240', Property_Area: 'Urban', Dependents: '3+', Education: 'Graduate', Married: 'No', Self_Employed: 'No', Gender: 'Male' },
  };
  const DEFAULTS = { Credit_History: '1', ApplicantIncome: 5000, CoapplicantIncome: 1500, LoanAmount: 128, Loan_Amount_Term: '360', Property_Area: 'Semiurban', Dependents: '0', Education: 'Graduate', Married: 'Yes', Self_Employed: 'No', Gender: 'Male' };

  const FACTOR_TIPS = {
    'Credit history': 'The single strongest signal. Lenders rarely approve applicants whose credit history misses guidelines.',
    'Household income': 'Combined applicant and co-applicant income, and what is left after the EMI.',
    'Loan size': 'Bigger loans relative to income mean a heavier monthly instalment.',
    'Loan term': 'Longer terms spread repayments out and lower the EMI.',
    'Property area': 'Semi-urban properties had the highest approval rate in past data.',
    'Marital status': 'Married applicants were approved slightly more often.',
    'Education': 'Graduates were approved slightly more often.',
    'Dependents': 'The number of people financially dependent on the applicant.',
    'Employment type': 'Salaried versus self-employed income.',
    'Gender': 'Included because it is in the original dataset; its effect is small.',
  };

  const ICONS = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-11"/></svg>',
    cross: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/></svg>',
  };

  // ---------- Theme ----------
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) {}
  });

  // ---------- Sidebar: highlight the section in view ----------
  const navLinks = $$('.side-nav a');
  const spy = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting || scrollY < 120) return;
    navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-35% 0px -60% 0px' });
  ['check', 'explore', 'scenarios', 'insights', 'model'].forEach((id) => { const n = document.getElementById(id); if (n) spy.observe(n); });
  addEventListener('scroll', () => { if (scrollY < 120) navLinks.forEach((a, i) => a.classList.toggle('active', i === 0)); }, { passive: true });

  // ---------- Form wiring ----------
  const paintRange = (r) => {
    const v = Math.min(Math.max(+r.value, +r.min), +r.max);
    r.style.setProperty('--pct', ((v - r.min) / (r.max - r.min)) * 100 + '%');
  };
  $$('.range').forEach((r) => {
    const input = $('#' + r.dataset.for);
    paintRange(r);
    r.addEventListener('input', () => { input.value = r.value; paintRange(r); schedule(); });
    input.addEventListener('input', () => { r.value = input.value || 0; paintRange(r); schedule(); });
  });
  $$('input[type=radio]', form).forEach((el) => el.addEventListener('change', () => schedule()));

  function setValues(values) {
    Object.entries(values).forEach(([name, value]) => {
      const radio = form.querySelector(`input[type=radio][name="${name}"][value="${value}"]`);
      if (radio) { radio.checked = true; return; }
      const input = $('#' + name);
      if (input) {
        input.value = value;
        const r = $(`.range[data-for="${name}"]`);
        if (r) { r.value = value; paintRange(r); }
      }
    });
    schedule(0);
  }
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => setValues(PRESETS[b.dataset.preset])));
  $('#resetBtn').addEventListener('click', () => setValues(DEFAULTS));
  const readForm = () => Object.fromEntries(new FormData(form).entries());

  // ---------- Prediction loop ----------
  let timer, mapTimer, ctrl, mapCtrl, lastResult = null, prevEligible = null;
  function schedule(delay = 140) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
    clearTimeout(mapTimer);
    mapTimer = setTimeout(runLandscape, delay + 200);
  }

  async function run() {
    const data = readForm();
    updateHint(data);
    ctrl?.abort();
    ctrl = new AbortController();
    panel.classList.add('loading');
    try {
      const out = await API.predict(data, ctrl.signal);
      $('#errorMsg').hidden = true;
      render(out, data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      const msg = $('#errorMsg');
      msg.textContent = err.message.replace(/_/g, ' ');
      msg.hidden = false;
    } finally {
      panel.classList.remove('loading');
    }
  }

  async function runLandscape() {
    const data = readForm();
    mapCtrl?.abort();
    mapCtrl = new AbortController();
    try {
      const land = await API.landscape(data, mapCtrl.signal);
      drawHeatmap(land, data);
      drawCurve($('#loanCurve'), land.loan_curve, +data.LoanAmount, 'LoanAmount', (v) => inr(v * 1000), 'Loan amount');
      drawCurve($('#incomeCurve'), land.income_curve, +data.ApplicantIncome, 'ApplicantIncome', inr, 'Monthly income');
    } catch (err) { /* the main panel already shows input errors */ }
  }

  function updateHint(d) {
    const income = (+d.ApplicantIncome || 0) + (+d.CoapplicantIncome || 0);
    const loan = (+d.LoanAmount || 0) * 1000;
    $('#loanHint').innerHTML = `That's <b>${inr(loan)}</b>, about <b>${income ? (loan / (income * 12)).toFixed(1) : '--'}×</b> your yearly household income. The typical loan here is ${inr(insights.dataset.median_loan * 1000)}.`;
  }

  function tween(el, to, fmt, dur = 650) {
    const from = +(el.dataset.v || 0), start = performance.now();
    el.dataset.v = to;
    if (reduceMotion) { el.textContent = fmt(to); return; }
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function render(out, data) {
    lastResult = { out, data };
    const p = out.approval_probability * 100;
    tween($('#probValue'), p, (v) => Math.round(v) + '%', 700);
    $('#gaugeFill').style.strokeDashoffset = 100 * (1 - out.approval_probability);
    panel.classList.toggle('is-good', out.eligible);
    panel.classList.toggle('is-bad', !out.eligible);

    const strength = p >= 80 ? 'Strong' : p >= 50 ? 'Moderate' : p >= 30 ? 'Weak' : 'Very weak';
    $('#verdictPill').innerHTML = out.eligible ? ICONS.check + 'Likely approved' : ICONS.cross + 'Likely rejected';
    renderKpis(out, data);
    $('#verdictText').textContent = out.eligible
      ? `${strength} application. The model expects approval with ${Math.round(p)}% confidence.`
      : `${strength} application. Approval needs at least 50%; see below for what would help most.`;

    const a = out.affordability;
    tween($('#emiValue'), a.emi, inr);
    const ratio = a.emi_to_income;
    $('#ratioValue').textContent = ratio == null ? '--' : Math.round(ratio * 100) + '%';
    const bar = $('#ratioBar');
    bar.style.width = Math.min(100, (ratio || 0) * 100) + '%';
    const level = ratio == null ? null : ratio > 0.5 ? ['bad', 'High', '--bad'] : ratio > 0.35 ? ['warn', 'Stretched', '--warn'] : ['good', 'Healthy', '--good'];
    bar.style.background = level ? `var(${level[2]})` : 'var(--track)';
    $('#ratioBadge').className = 'trend ' + (level ? level[0] : '');
    $('#ratioBadge').textContent = level ? level[1] : '--';

    renderFactors(out.factors);
    renderBoosts(out.suggestions, out.eligible);
    updateStickyBar(out);
    $('#saveBtn').classList.remove('saved');
    $('#saveBtn').innerHTML = ICONS.bookmark + 'Save scenario to compare';

    if (prevEligible === false && out.eligible) {
      celebrate();
      toast(`You crossed into approval territory at ${Math.round(p)}%.`, 'good', ICONS.check);
    }
    prevEligible = out.eligible;
  }

  // ---------- KPI tiles ----------
  const history = [];
  function renderKpis(out, data) {
    const p = out.approval_probability;
    tween($('#kpiOdds'), p * 100, (v) => Math.round(v) + '%', 700);
    const prev = history.length ? history[history.length - 1] : null;
    const delta = prev == null ? 0 : Math.round((p - prev) * 100);
    const badge = $('#kpiOddsDelta');
    badge.className = 'trend ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : '');
    badge.textContent = prev == null || delta === 0 ? (p >= 0.5 ? 'Above 50%' : 'Below 50%') : (delta > 0 ? '▲ +' : '▼ ') + delta + ' pts';
    history.push(p);
    if (history.length > 16) history.shift();
    drawSpark();

    $('#kpiTerm').textContent = `over ${data.Loan_Amount_Term / 12} years · ${inr(data.LoanAmount * 1000)} loan`;
    const yearly = ((+data.ApplicantIncome || 0) + (+data.CoapplicantIncome || 0)) * 12;
    const lti = yearly ? (data.LoanAmount * 1000) / yearly : null;
    $('#kpiLti').textContent = lti == null ? '--' : lti.toFixed(1) + '×';
    $('#kpiLtiFoot').textContent = `${inr(yearly)} household income a year`;
  }
  function drawSpark() {
    const svg = $('#kpiSpark');
    const W = 120, H = 32, n = history.length;
    svg.replaceChildren();
    el('line', { class: 'sp-mid', x1: 0, x2: W, y1: H / 2, y2: H / 2 }, svg);
    if (n < 2) return;
    const pts = history.map((v, i) => [(i / (n - 1)) * W, H - v * H]);
    const d = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('');
    el('path', { class: 'sp-area', d: `${d}L${W} ${H}L0 ${H}Z` }, svg);
    el('path', { class: 'sp-line', d }, svg);
  }

  function renderFactors(factors) {
    const top = factors.slice(0, 6);
    const max = Math.max(1, ...top.map((f) => Math.abs(f.impact)));
    const list = $('#factorList');
    const existing = new Map($$('.factor', list).map((li) => [li.dataset.factor, li]));
    list.replaceChildren(...top.map((f) => {
      let li = existing.get(f.factor);
      if (!li) {
        li = document.createElement('li');
        li.className = 'factor';
        li.dataset.factor = f.factor;
        li.innerHTML = `<span class="factor-name">${f.factor}</span><span class="factor-track"><span class="factor-bar"></span></span><span class="factor-val"></span>`;
        bindTip(li, () => {
          const v = +li.dataset.impact;
          return `<b>${f.factor}</b> ${v >= 0 ? 'helps' : 'hurts'} this application (${v >= 0 ? '+' : ''}${v.toFixed(2)} log-odds).<br>${FACTOR_TIPS[f.factor] || ''}`;
        });
      }
      li.dataset.impact = f.impact;
      const w = (Math.abs(f.impact) / max) * 50;
      const bar = $('.factor-bar', li);
      bar.className = 'factor-bar ' + (f.impact >= 0 ? 'up' : 'down');
      bar.style.width = w + '%';
      bar.style.left = f.impact >= 0 ? '50%' : (50 - w) + '%';
      $('.factor-val', li).textContent = (f.impact >= 0 ? '+' : '−') + Math.abs(f.impact).toFixed(2);
      li.setAttribute('aria-label', `${f.factor} ${f.impact >= 0 ? 'helps' : 'hurts'} by ${Math.abs(f.impact).toFixed(2)}`);
      return li;
    }));
  }

  function renderBoosts(suggestions, eligible) {
    const box = $('#boostList');
    if (!suggestions.length) {
      box.innerHTML = `<div class="boost-empty">${eligible ? 'This profile is already about as strong as it gets.' : 'No simple change moves the needle much here.'}</div>`;
      return;
    }
    box.replaceChildren(...suggestions.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'boost';
      b.innerHTML = `<span class="boost-icon"><svg viewBox="0 0 24 24"><path d="M4 17l6-6 4 4 7-7"/><path d="M15 8h6v6"/></svg></span>
        <span class="boost-text">${s.label}<small>Tap to apply · odds become ${pct(s.new_probability)}</small></span>
        <span class="boost-delta">+${Math.round(s.delta * 100)} pts</span>`;
      b.addEventListener('click', () => {
        setValues(Object.fromEntries(Object.entries(s.change).map(([k, v]) => [k, String(v)])));
        toast(`Applied: ${s.label.toLowerCase()}.`, 'info', ICONS.spark);
      });
      return b;
    }));
  }

  // ---------- Tooltip ----------
  function placeTip(e) {
    const x = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 10);
    const y = e.clientY + 16 + tooltip.offsetHeight > window.innerHeight ? e.clientY - tooltip.offsetHeight - 12 : e.clientY + 16;
    tooltip.style.left = Math.max(10, x) + 'px';
    tooltip.style.top = y + 'px';
  }
  const showTip = (html, e) => { tooltip.innerHTML = html; tooltip.hidden = false; placeTip(e); };
  const hideTip = () => { tooltip.hidden = true; };
  function bindTip(el, html) {
    el.addEventListener('mouseenter', (e) => showTip(html(), e));
    el.addEventListener('mousemove', placeTip);
    el.addEventListener('mouseleave', hideTip);
  }

  // ---------- SVG helpers ----------
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (parent) parent.appendChild(n);
    return n;
  };
  const heatFill = (p) => p >= 0.5
    ? `color-mix(in oklab, var(--good) ${Math.round((p - 0.5) * 200)}%, var(--heat-mid))`
    : `color-mix(in oklab, var(--bad) ${Math.round((0.5 - p) * 200)}%, var(--heat-mid))`;
  const short = (n) => n >= 1000 ? (n / 1000) + 'k' : String(n);

  // ---------- Approval map ----------
  function drawHeatmap(land, data) {
    const svg = $('#heatmap');
    const W = 560, H = 380, L = 58, R = 8, T = 8, B = 44;
    const cols = land.income_axis.length, rows = land.loan_axis.length;
    const cw = (W - L - R) / cols, ch = (H - T - B) / rows;
    const yOf = (r) => T + (rows - 1 - r) * ch;
    svg.replaceChildren();

    const cells = el('g', {}, svg);
    land.grid.forEach((row, r) => row.forEach((p, c) => {
      const rect = el('rect', { class: 'cell', x: L + c * cw, y: yOf(r), width: cw, height: ch, rx: 2.5 }, cells);
      rect.style.fill = heatFill(p);
      const income = land.income_axis[c], loan = land.loan_axis[r];
      rect.addEventListener('mouseenter', (e) => showTip(`<b>${pct(p)} odds</b><br>Income ${inr(income)} · Loan ${inr(loan * 1000)}<br><small>Click to try this</small>`, e));
      rect.addEventListener('mousemove', placeTip);
      rect.addEventListener('mouseleave', hideTip);
      rect.addEventListener('click', () => {
        setValues({ ApplicantIncome: income, LoanAmount: loan });
        toast(`Trying income ${inr(income)} with a ${inr(loan * 1000)} loan.`, 'info', ICONS.spark);
      });
    }));

    // Outline where the decision flips between approved and rejected
    let d = '';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const ok = land.grid[r][c] >= 0.5;
      if (c + 1 < cols && (land.grid[r][c + 1] >= 0.5) !== ok) { const x = L + (c + 1) * cw; d += `M${x} ${yOf(r)}V${yOf(r) + ch}`; }
      if (r + 1 < rows && (land.grid[r + 1][c] >= 0.5) !== ok) { const y = yOf(r); d += `M${L + c * cw} ${y}H${L + (c + 1) * cw}`; }
    }
    if (d) el('path', { class: 'boundary', d }, svg);

    const axis = el('g', { class: 'axis' }, svg);
    land.income_axis.forEach((v, c) => {
      if (v % 5000) return;
      el('text', { x: L + c * cw + cw / 2, y: H - B + 16, 'text-anchor': 'middle' }, axis).textContent = short(v);
    });
    land.loan_axis.forEach((v, r) => {
      if (v % 100) return;
      el('text', { x: L - 8, y: yOf(r) + ch / 2 + 4, 'text-anchor': 'end' }, axis).textContent = '₹' + v + 'K';
    });
    el('text', { class: 'title', x: L + (W - L - R) / 2, y: H - 6, 'text-anchor': 'middle' }, axis).textContent = 'Your monthly income (₹)';
    el('text', { class: 'title', x: 12, y: T + (H - T - B) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${T + (H - T - B) / 2})` }, axis).textContent = 'Loan amount';

    // Marker for the current application
    const inc0 = land.income_axis[0], incStep = land.income_axis[1] - inc0;
    const loan0 = land.loan_axis[0], loanStep = land.loan_axis[1] - loan0;
    const cx = L + Math.min(cols - 0.5, Math.max(0.5, (+data.ApplicantIncome - inc0) / incStep + 0.5)) * cw;
    const cy = T + (H - T - B) - Math.min(rows - 0.5, Math.max(0.5, (+data.LoanAmount - loan0) / loanStep + 0.5)) * ch;
    const m = el('g', {}, svg);
    if (!reduceMotion) el('circle', { class: 'marker-pulse', cx, cy, r: 9 }, m);
    el('circle', { class: 'marker-ring', cx, cy, r: 10 }, m);
    el('circle', { class: 'marker-core', cx, cy, r: 5.5 }, m);
  }

  // ---------- What-if curves ----------
  function drawCurve(svg, curve, current, field, fmt, label) {
    const W = 420, H = 190, L = 40, R = 14, T = 12, B = 30;
    const xs = curve.x, ps = curve.p, x0 = xs[0], x1 = xs[xs.length - 1];
    const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
    const Y = (p) => T + (1 - p) * (H - T - B);
    const id = svg.id;
    svg.replaceChildren();

    const defs = el('defs', {}, svg);
    const sg = el('linearGradient', { id: id + 'Stroke', x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    el('stop', { offset: '0%', style: 'stop-color: var(--accent)' }, sg);
    el('stop', { offset: '100%', style: 'stop-color: var(--accent-2)' }, sg);
    const ag = el('linearGradient', { id: id + 'Area', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0%', style: 'stop-color: var(--accent); stop-opacity: .32' }, ag);
    el('stop', { offset: '100%', style: 'stop-color: var(--accent); stop-opacity: 0' }, ag);

    const axis = el('g', { class: 'axis' }, svg);
    [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
      el('line', { class: 'grid-line', x1: L, x2: W - R, y1: Y(p), y2: Y(p) }, svg);
      el('text', { x: L - 8, y: Y(p) + 4, 'text-anchor': 'end' }, axis).textContent = Math.round(p * 100) + '%';
    });
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const v = x0 + ((x1 - x0) * i) / ticks;
      const nice = field === 'LoanAmount' ? '₹' + Math.round(v) + 'K' : short(Math.round(v / 100) * 100);
      el('text', { x: X(v), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, axis).textContent = nice;
    }
    el('line', { class: 'threshold', x1: L, x2: W - R, y1: Y(0.5), y2: Y(0.5) }, svg);
    el('text', { class: 'threshold-label', x: W - R, y: Y(0.5) + 14, 'text-anchor': 'end' }, svg).textContent = 'Approval line';

    const pts = xs.map((x, i) => [X(x), Y(ps[i])]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    el('path', { class: 'area', d: `${line}L${X(x1)} ${Y(0)}L${X(x0)} ${Y(0)}Z`, fill: `url(#${id}Area)` }, svg);
    el('path', { class: 'line', d: line, stroke: `url(#${id}Stroke)` }, svg);

    // Current position
    const cv = Math.min(x1, Math.max(x0, current));
    let k = 0;
    while (k < xs.length - 2 && xs[k + 1] < cv) k++;
    const t = (cv - xs[k]) / (xs[k + 1] - xs[k]);
    const cp = ps[k] + (ps[k + 1] - ps[k]) * Math.min(1, Math.max(0, t));
    if (!reduceMotion) el('circle', { class: 'marker-pulse', cx: X(cv), cy: Y(cp), r: 7 }, svg);
    el('circle', { class: 'marker-core', cx: X(cv), cy: Y(cp), r: 6 }, svg);
    $(field === 'LoanAmount' ? '#loanNow' : '#incomeNow').textContent = `You: ${pct(cp)}`;

    // Hover crosshair and click-to-set
    const hl = el('line', { class: 'hover-line', y1: T, y2: H - B, visibility: 'hidden' }, svg);
    const hd = el('circle', { class: 'hover-dot', r: 5, visibility: 'hidden' }, svg);
    const hit = el('rect', { class: 'hit', x: L, y: T, width: W - L - R, height: H - T - B }, svg);
    const nearest = (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      let best = 0;
      xs.forEach((x, i) => { if (Math.abs(X(x) - vx) < Math.abs(X(xs[best]) - vx)) best = i; });
      return best;
    };
    hit.addEventListener('mousemove', (e) => {
      const i = nearest(e);
      [hl, hd].forEach((n) => n.setAttribute('visibility', 'visible'));
      hl.setAttribute('x1', X(xs[i])); hl.setAttribute('x2', X(xs[i]));
      hd.setAttribute('cx', X(xs[i])); hd.setAttribute('cy', Y(ps[i]));
      showTip(`<b>${pct(ps[i])} odds</b><br>${label}: ${fmt(xs[i])}<br><small>Click to try this</small>`, e);
    });
    hit.addEventListener('mouseleave', () => { [hl, hd].forEach((n) => n.setAttribute('visibility', 'hidden')); hideTip(); });
    hit.addEventListener('click', (e) => {
      const i = nearest(e);
      setValues({ [field]: xs[i] });
      toast(`${label} set to ${fmt(xs[i])}.`, 'info', ICONS.spark);
    });
  }

  // ---------- Saved scenarios ----------
  const STORE = 'loansense-scenarios';
  let scenarios = [];
  try { scenarios = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { scenarios = []; }
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(scenarios)); } catch (e) {} };

  $('#saveBtn').addEventListener('click', () => {
    if (!lastResult) return;
    const key = JSON.stringify(lastResult.data);
    if (scenarios.some((s) => JSON.stringify(s.data) === key)) { toast('This scenario is already saved.', 'info', ICONS.bookmark); return; }
    if (scenarios.length >= 4) scenarios.shift();
    const used = new Set(scenarios.map((s) => s.name));
    const name = 'Scenario ' + ['A', 'B', 'C', 'D', 'E'].find((l) => !used.has('Scenario ' + l));
    scenarios.push({ name, data: lastResult.data, p: lastResult.out.approval_probability, emi: lastResult.out.affordability.emi });
    persist();
    renderScenarios();
    $('#saveBtn').classList.add('saved');
    $('#saveBtn').innerHTML = ICONS.check + `Saved as ${name}`;
    toast(`${name} saved. Compare it in the What-if explorer.`, 'good', ICONS.bookmark);
  });
  $('#clearScenarios').addEventListener('click', () => { scenarios = []; persist(); renderScenarios(); });

  function renderScenarios() {
    const list = $('#scenarioList');
    $('#scenarioCount').textContent = `${scenarios.length} of 4`;
    $('#clearScenarios').hidden = !scenarios.length;
    if (!scenarios.length) {
      list.innerHTML = `<div class="sc-empty">${ICONS.bookmark}<span>Save a scenario from the results panel, change some details, then save another to compare them side by side.</span></div>`;
      return;
    }
    const best = Math.max(...scenarios.map((s) => s.p));
    list.replaceChildren(...scenarios.map((s, i) => {
      const card = document.createElement('div');
      const good = s.p >= 0.5;
      const isBest = s.p === best && scenarios.length > 1;
      card.className = 'scenario' + (isBest ? ' best' : '');
      const d = s.data;
      card.innerHTML = `
        <div class="sc-top"><span class="sc-name">${s.name}</span>${isBest ? '<span class="sc-badge">Best odds</span>' : ''}</div>
        <div class="sc-odds ${good ? 'good' : 'bad'}">${pct(s.p)}</div>
        <div class="sc-meter"><i style="width:${s.p * 100}%;background:var(${good ? '--good' : '--bad'})"></i></div>
        <div class="sc-facts">
          <span>Income ${inr(+d.ApplicantIncome + +d.CoapplicantIncome)}</span>
          <span>Loan ${inr(d.LoanAmount * 1000)}</span>
          <span>${d.Loan_Amount_Term / 12} years</span>
          <span>EMI ${inr(s.emi)}</span>
          <span>Credit ${d.Credit_History === '1' ? 'good' : 'poor'}</span>
        </div>
        <div class="sc-actions"><button type="button" class="sc-load">Load</button><button type="button" class="sc-del" aria-label="Remove ${s.name}">Remove</button></div>`;
      $('.sc-load', card).addEventListener('click', () => {
        setValues(s.data);
        $('#check').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
        toast(`${s.name} loaded.`, 'info', ICONS.bookmark);
      });
      $('.sc-del', card).addEventListener('click', () => { scenarios.splice(i, 1); persist(); renderScenarios(); });
      return card;
    }));
  }
  renderScenarios();

  // ---------- Toasts ----------
  function toast(text, kind = 'info', icon = ICONS.check) {
    const stack = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = `<span class="toast-icon">${icon}</span><span>${text}</span>`;
    stack.appendChild(t);
    while (stack.children.length > 3) stack.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2600);
  }

  // ---------- Celebration ----------
  function celebrate() {
    if (reduceMotion) return;
    const c = $('#confetti'), ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = $('.gauge-wrap').getBoundingClientRect();
    const ox = g.left + g.width / 2, oy = g.top + g.height / 2;
    const css = getComputedStyle(document.documentElement);
    const colors = ['--good', '--accent', '--accent-2', '--warn'].map((v) => css.getPropertyValue(v).trim());
    const parts = Array.from({ length: 140 }, () => {
      const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 9;
      return { x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 5, w: 5 + Math.random() * 6, h: 3 + Math.random() * 4,
        r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[Math.floor(Math.random() * colors.length)] };
    });
    const start = performance.now();
    (function frame(t) {
      const age = (t - start) / 1000;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - age / 1.8);
      parts.forEach((p) => {
        p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      });
      if (age < 1.8) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  }

  // ---------- Mobile sticky result bar ----------
  let resultVisible = true, workspaceVisible = true;
  function syncSticky() { $('#stickyBar').hidden = resultVisible || !workspaceVisible || innerWidth > 900; }
  function updateStickyBar(out) {
    $('#sbValue').textContent = pct(out.approval_probability);
    $('#sbVerdict').textContent = out.eligible ? 'likely approved' : 'likely rejected';
    $('#sbDot').className = 'sb-dot ' + (out.eligible ? 'good' : 'bad');
  }
  new IntersectionObserver(([e]) => { resultVisible = e.isIntersecting; syncSticky(); }, { threshold: 0.12 }).observe(panel);
  new IntersectionObserver(([e]) => { workspaceVisible = e.isIntersecting; syncSticky(); }).observe($('#check'));
  addEventListener('resize', syncSticky);

  // ---------- Insights: approval rate by group ----------
  const grid = $('#segmentGrid');
  insights.segments.forEach((seg) => {
    const card = document.createElement('div');
    card.className = 'segment';
    card.innerHTML = `<h3>${seg.title}</h3>
      <div><div class="seg-bars">${seg.rows.map((r) => `
        <div class="seg-col"><b>${Math.round(r.rate * 100)}%</b><div class="seg-bar" style="height:${Math.max(4, r.rate * 130)}px"></div></div>`).join('')}
      </div><div class="seg-labels">${seg.rows.map((r) => `<span>${r.label}</span>`).join('')}</div></div>`;
    $$('.seg-col', card).forEach((col, i) => {
      const r = seg.rows[i];
      bindTip(col, () => `<b>${r.label}</b><br>${Math.round(r.rate * r.count)} of ${r.count} approved (${(r.rate * 100).toFixed(1)}%)`);
    });
    grid.appendChild(card);
  });

  schedule(0);
})();
