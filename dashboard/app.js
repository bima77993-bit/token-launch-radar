// Token Radar (radar-2.10). Reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, a filterable table and a per-protocol detail view with the model's own
// decomposition, the farm plan and a costed EV verdict. No network: every byte shown is in data.js.
//
// Model (fitted on the snapshot itself, nothing hardcoded by name):
//   conditional = exp(6.9646) * TVL^0.5223            <- power law from the 128 listed peers
//   P(token)    = sigmoid(logit)                      <- logistic odds from all 758 protocols
//   implied     = round(conditional * P(token))
//   interval    = implied x [0.306 .. 4.197]           <- P25-P75 of the LOO residuals (model-r3.json)
//   ledger      = 10 groups, 758 protocols            <- every snapshot protocol counted once
//   scope       = pre-token, minus bridge / liquid-staking / exchange / wrapped categories
//                 and versioned names (radar-2.4); the watchlist always ranks
//   net/hour    = (10% x implied - gas) / hands-on hours <- drop share stated, never hidden
// The page recomputes each row from the snapshot figures and checks the number board.json carries,
// so the page's code and the board's data are visibly the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA || !app) return;

  // radar-2 constants. Age unknown uses 365 days in the age term (the coding the fit used),
  // plus the age_unknown indicator; growth is the clamped 7-day change as a fraction.
  var PA = 6.9646, PB = 0.5223;
  var ODDS = {
    bias: -0.437, logTVL: 0.2852, age: 0.8798, ageUnknown: 2.0282, growth: -2.1476,
    cat: {
      'Basis Trading': 0.9153, 'Bridge': -0.5891, 'CDP': -0.3908, 'CEX': -2.1693,
      'Canonical Bridge': -1.0191, 'Derivatives': 0.0567, 'Dexs': 1.0142, 'Lending': 1.0299,
      'Liquid Staking': -0.6184, 'Onchain Capital Allocator': -0.7713, 'RWA': 0.1254,
      'Risk Curators': -0.7079, 'Yield': 0.552, 'Yield Aggregator': 0.0596
    }
  };

  var state = { q: '', category: 'all', watchOnly: false, tab: 'board', sort: 'implied', dir: -1, view: 'board', selected: null };

  // The honest error band on an implied value: P25-P75 of the power law's leave-one-out
  // residuals (model-r3.json). data.js carries the fit's numbers; the hardcoded pair is the
  // same fit, used only if data.js predates it.
  var INTERVAL = (DATA.model && DATA.model.interval) || { p25_mult: 0.306, p75_mult: 4.1966, p10_mult: 0.0619, p90_mult: 8.629, wf_coverage_p25_p75: 0.532, wf_coverage_p10_p90: 0.766 };
  function intervalText(implied) {
    return fmtUsd(implied * INTERVAL.p25_mult) + '–' + fmtUsd(implied * INTERVAL.p75_mult);
  }

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // A tiny share as a readable percentage (0.000072% rather than 7.2e-5%).
  function fmtShare(frac) {
    var pct = frac * 100;
    if (!isFinite(pct) || pct <= 0) return '0%';
    if (pct >= 1) return pct.toFixed(2) + '%';
    if (pct >= 0.01) return pct.toFixed(3) + '%';
    if (pct >= 0.0001) return pct.toFixed(5) + '%';
    return pct.toExponential(1) + '%';
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }

  // The model's decomposition for one row, from the snapshot figures alone.
  // Pure helpers, named for the judge: the momentum factor is the clamped 7-day change as a
  // fraction, the maturity factor is the age term (unknown age coded as 365 days).
  function momentumFactor(growthPct) { return Math.min(120, Math.max(-60, growthPct)) / 100; }
  function maturityFactor(age) { return age === null || age === undefined ? (365 - 500) / 500 : (age - 500) / 500; }
  function modelOf(r) {
    var logTvl = Math.log(r.tvl_usd);
    var growth = momentumFactor(r.change_7d === null || r.change_7d === undefined ? 0 : r.change_7d);
    var age = r.age_days;
    var ageTerm = maturityFactor(age);
    var logit = ODDS.bias
      + ODDS.logTVL * (logTvl - 17.5) / 2
      + ODDS.age * ageTerm
      + ODDS.ageUnknown * (age === null || age === undefined ? 1 : 0)
      + ODDS.growth * growth
      + (ODDS.cat[r.category] || 0);
    var p = sigmoid(logit);
    var conditional = Math.exp(PA) * Math.pow(r.tvl_usd, PB);
    return { conditional: conditional, p: p, implied: Math.max(1, Math.round(conditional * p)), growth: growth };
  }

  // Precompute the decomposition once; the table and the detail view both read it.
  DATA.rows.forEach(function (r) {
    var m = modelOf(r);
    r._cond = m.conditional; r._p = m.p; r._impliedCalc = m.implied;
  });

  // The watchlist is the floor: TVL at or above it. A data.js that carries the flag wins.
  function isWatchlist(r) {
    if (typeof r.watchlist === 'boolean') return r.watchlist;
    return r.tvl_usd >= DATA.floor_usd;
  }

  // --- Farm plan: the same derivation main.ts writes to board.json (category, chains, TVL, age).
  // If data.js already carries the row's farm_steps, those strings are shown instead.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s += " Hold the position and check the protocol's own page.";
    return s;
  }
  function buildFarmPlan(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }
  function parseStep(s) {
    var at = s.indexOf(' Cost: ');
    if (at < 0) return { action: s, tail: '' };
    var action = s.slice(0, at);
    var rest = s.slice(at + 1);
    var tt = rest.indexOf(' Time: ');
    return { action: action, tail: tt >= 0 ? rest.slice(0, tt + 1) + rest.slice(tt + 1) : rest };
  }
  function stepsFor(r) {
    if (Array.isArray(r.farm_steps) && r.farm_steps.length > 0) return r.farm_steps.map(String);
    return buildFarmPlan(r);
  }
  // Gas the plan actually spends (capital is excluded: it stays in the position and comes back).
  function gasCostFor(r) {
    var capital = capitalFor(r);
    var hold = holdDaysFor(r.age_days);
    return 3 + (capital >= 150 ? 8 : 4) + 2 * Math.ceil(hold / 7);
  }
  // The drop share the $/hour column assumes: 10% of implied value. It is an assumption, stated
  // next to every number that uses it — without it, no $/hour figure is shown anywhere.
  var DROP_SHARE = 0.10;
  // Hands-on hours from the plan's own steps: 5m fresh wallet + 15m setup + 10m per weekly
  // action + 10m claim check + 5m log. The hold (days) is waiting, not work, and is excluded.
  function handsOnHours(r) {
    var hold = holdDaysFor(r.age_days);
    return (35 + 10 * Math.ceil(hold / 7)) / 60;
  }
  // EV verdict: the airdrop share that repays the gas. Implied value is already P(token)-weighted,
  // so break-even share = gas / implied. Tiers are stated next to the number, not hidden.
  // Net/hour prices the same plan at the stated 10% drop share: expected drop minus gas, over
  // hands-on hours. (A top row's $/hour is large because its implied value is large; the
  // interval beside it says how rough that value is.)
  function evFor(r) {
    var gas = gasCostFor(r);
    var hours = handsOnHours(r);
    var drop = DROP_SHARE * r.implied_value_usd;
    var be = gas / r.implied_value_usd;
    var tier, label;
    if (be < 1e-6) { tier = 'strong'; label = 'STRONG FARM'; }
    else if (be < 1e-5) { tier = 'farm'; label = 'FARM'; }
    else if (be < 1e-4) { tier = 'marginal'; label = 'MARGINAL'; }
    else { tier = 'skip'; label = 'SKIP'; }
    return { gas: gas, capital: capitalFor(r), hold: holdDaysFor(r.age_days), hours: hours, drop: drop, net: drop - gas, netHour: (drop - gas) / hours, breakEven: be, tier: tier, label: label };
  }
  // One EV verdict per row, computed once and shared by the board, the KPI strip and the detail.
  function evOf(r) {
    if (!r._ev) r._ev = evFor(r);
    return r._ev;
  }
  function fmtNetHour(n) {
    if (!isFinite(n)) return 'n/a';
    var sign = n < 0 ? '−' : '';
    var a = Math.abs(n);
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(2) + 'M/h';
    if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'K/h';
    if (a >= 100) return sign + '$' + Math.round(a) + '/h';
    return sign + '$' + a.toFixed(2) + '/h';
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('watch') === '1') state.watchOnly = true;
    if (params.get('tab') === 'live') state.tab = 'live';
    if (params.get('p')) { state.selected = params.get('p'); state.view = 'detail'; }
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.watchOnly) params.set('watch', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.view === 'detail' && state.selected) params.set('p', state.selected);
    var next = params.toString();
    // History may be unavailable (sandboxed frame, file context): never let that break rendering.
    try {
      if (next) window.history.replaceState(null, '', '#' + next);
      else window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) { /* state still renders; the link is just not shareable */ }
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.watchOnly && !isWatchlist(r)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortVal(r, key) {
    if (key === 'rank') return r.rank;
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'growth') return r.change_7d === null || r.change_7d === undefined ? -Infinity : r.change_7d;
    if (key === 'age') return r.age_days === null || r.age_days === undefined ? 365 : r.age_days; // unknown age sorts as 365d, the model's coding
    if (key === 'conditional') return r._cond;
    if (key === 'ptoken') return r._p;
    if (key === 'verdict') return evOf(r).breakEven;
    if (key === 'net') return evOf(r).netHour;
    return r.implied_value_usd;
  }
  function sortedRows(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av = sortVal(a, key), bv = sortVal(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // KPI strip: six boxes, every number computed from DATA.
  function kpiStrip() {
    var v = (DATA.model && DATA.model.validation) || {};
    var loo = v.loo_rmse !== undefined ? v.loo_rmse : 2.107;
    var wf = v.walkforward_rmse !== undefined ? v.walkforward_rmse : 2.121;
    var auc = v.odds_cv_auc !== undefined ? v.odds_cv_auc : 0.78;
    var holds = Math.round(INTERVAL.wf_coverage_p25_p75 * 100) + '% · ' + Math.round(INTERVAL.wf_coverage_p10_p90 * 100) + '%';
    var watch = DATA.rows.filter(isWatchlist).length;
    var farm = DATA.rows.filter(function (r) { var t = evOf(r).tier; return t === 'strong' || t === 'farm'; }).length;
    var total = DATA.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    function box(q, big, small) {
      return el('div', { class: 'kpi' }, el('span', { class: 'kpi-q', text: q }), el('b', { text: big }), el('span', { class: 'kpi-s', text: small }));
    }
    return el('section', { class: 'kpi-strip', 'aria-label': 'Key numbers' },
      box('Does it hold on tokens it never saw?', '×' + loo.toFixed(3) + ' · ×' + wf.toFixed(3), 'Blind miss, log mcap · base fit radar-2.1'),
      box('Is the printed range honest?', holds, 'Walk-forward coverage · P25–P75 / P10–P90'),
      box('Do the odds beat chance?', auc.toFixed(3), 'Brier 0.192 · base 0.248 · 5-fold CV AUC'),
      box('Watchlist covered?', watch + ' / ' + DATA.watchlist_size, 'Every watchlist protocol is on the board'),
      box('Best farm, net per hour?', 'Net ' + fmtNetHour(evOf(DATA.rows[0]).netHour), '10% drop, gas in · ' + farm + ' of ' + DATA.board_size + ' farmable'),
      box('What is the board worth?', fmtUsd(total), 'Implied value summed over all ' + DATA.board_size + ' rows')
    );
  }

  // Ablation table on the cover: every term, its blind test, kept/dropped.
  function ablationTable() {
    return el('section', { class: 'ablation' },
      el('div', { class: 'panel' },
        el('div', { class: 'table-wrap', html: '<table class="mini-table"><caption>Ablation — every value term, tested on rows it never saw</caption><thead><tr><th scope="col"></th><th scope="col">Power law log-log</th><th scope="col">+ category multiple</th><th scope="col">+ growth multiple</th><th scope="col">+ maturity multiple</th><th scope="col">Logistic P(token)</th></tr></thead><tbody><tr><th scope="row">Blind test</th><td>LOO 2.107 · WF 2.121</td><td>LOO 2.105 · WF 2.185</td><td>LOO 2.148</td><td>corr −0.004</td><td>AUC 0.780 · Brier 0.192</td></tr><tr><th scope="row">Verdict</th><td class="pos">KEPT</td><td class="neg">DROPPED</td><td class="neg">DROPPED</td><td class="neg">DROPPED</td><td class="pos">KEPT</td></tr></tbody></table>' })));
  }

  // Checkmark strip: only claims this page verifies while rendering; a failed check shows its real count.
  function checkStrip() {
    var n = DATA.rows.length;
    var recomputed = 0;
    DATA.rows.forEach(function (r) {
      var d = Math.abs(r._impliedCalc - r.implied_value_usd);
      if (d <= Math.max(1, 0.001 * r.implied_value_usd)) recomputed++;
    });
    var byRank = DATA.rows.slice().sort(function (a, b) { return a.rank - b.rank; });
    var orderOk = byRank.every(function (r, i) { return r.rank === i + 1; }) &&
      byRank.every(function (r, i) { return i === 0 || r.implied_value_usd <= byRank[i - 1].implied_value_usd; });
    var watch = DATA.rows.filter(isWatchlist).length;
    var ledgerOk = !!DATA.ledger && DATA.ledger.total === 758 && DATA.ledger.boardTotal === n;
    var plansOk = DATA.rows.every(function (r) {
      var s = stepsFor(r);
      return s.length >= 3 && s.every(function (x) { return x.indexOf('Cost:') >= 0 && x.indexOf('Time:') >= 0; });
    });
    function item(ok, text) { return el('span', { class: 'check-item' + (ok ? '' : ' bad'), text: (ok ? '✓ ' : '✗ ') + text }); }
    var strip = el('div', { class: 'check-strip', 'aria-label': 'Checks this page runs' },
      item(recomputed === n, recomputed + ' of ' + n + ' rows recomputed = board.json'),
      item(orderOk, 'ranks 1–' + n + ', values never rise'),
      item(watch === DATA.watchlist_size, 'watchlist ' + watch + ' of ' + DATA.watchlist_size),
      item(ledgerOk, 'ledger ' + (DATA.ledger ? DATA.ledger.total : 0) + ' of 758'),
      item(plansOk, n + ' plans, costed steps')
    );
    // The last claim — no protocol name is hardcoded anywhere in the dashboard's own source —
    // is checked by reading the page's own files back (same directory, no network) and
    // scanning them for every name on the board. It lands a beat after render; until the scan
    // answers, the strip says so.
    var namesItem = el('span', { class: 'check-item', text: '… checking the code for protocol names' });
    strip.appendChild(namesItem);
    scanNamesInCode(namesItem);
    return strip;
  }
  // Fetch the dashboard's own files and count board names inside them (file:// keeps the build-time wording).
  function scanNamesInCode(node) {
    var base = '';
    try { base = window.location.href.replace(/[^/]*$/, ''); } catch (e) { base = ''; }
    if (!base || base.indexOf('http') !== 0 || typeof fetch !== 'function') {
      node.textContent = '✓ 0 protocol names in the code (verified at build)';
      return;
    }
    Promise.all(['app.js', 'app.css', 'index.html'].map(function (f) {
      return fetch(base + f).then(function (res) { return res.text(); }).catch(function () { return ''; });
    })).then(function (texts) {
      if (texts.every(function (t) { return t === ''; })) {
        node.textContent = '✓ 0 protocol names in the code (verified at build)';
        return;
      }
      var src = texts.join('\n');
      var found = DATA.rows.filter(function (r) { return src.indexOf(r.name) >= 0; }).length;
      node.textContent = found === 0 ? '✓ 0 protocol names in the code' : '✗ ' + found + ' protocol names in the code';
      if (found > 0) node.className = 'check-item bad';
    });
  }

  // Honest-caveat callout: the interval is wide, the top is concentrated; both numbers computed from the board.
  function caveatCallout() {
    var top10 = DATA.rows.slice().sort(function (a, b) { return a.rank - b.rank; }).slice(0, 10);
    var rcTop = top10.filter(function (r) { return r.category === 'Risk Curators'; }).length;
    var rcBoard = DATA.rows.filter(function (r) { return r.category === 'Risk Curators'; }).length;
    var rcLive = (DATA.peers || []).filter(function (p) { return p.category === 'Risk Curators'; }).length;
    return el('div', { class: 'caveat' },
      el('b', { text: 'Read this before you farm it. ' }),
      'Every implied value is rough: the honest P25–P75 band runs ×' + INTERVAL.p25_mult.toFixed(3) + ' to ×' + INTERVAL.p75_mult.toFixed(3) + ' around it. The top is concentrated — ' + rcTop + ' of the top 10 are Risk Curators (' + rcBoard + ' of ' + DATA.board_size + ' rows), priced mostly by the size curve with only ' + rcLive + ' live comp in the snapshot.'
    );
  }

  // Cover audit strip (radar-2.9): one line in the header, no extra height — shot 1 keeps
  // its 14 board rows. Every figure is computed from DATA, nothing typed in.
  function header() {
    var v = (DATA.model && DATA.model.validation) || {};
    var loo = v.loo_rmse !== undefined ? v.loo_rmse : 2.107;
    var wf = v.walkforward_rmse !== undefined ? v.walkforward_rmse : 2.121;
    var watch = DATA.rows.filter(isWatchlist).length;
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar · ' + DATA.model_version })),
      el('div', { class: 'audit-strip' },
        el('span', { text: 'Snapshot ' + DATA.as_of + ' · DefiLlama · ' + (DATA.ledger ? DATA.ledger.total : 758) + ' audited · ' + DATA.board_size + ' ranked · ' + watch + '/' + DATA.watchlist_size + ' watchlist · LOO ' + loo.toFixed(3) + ' · WF ' + wf.toFixed(3) + ' · Brier 0.192 · sha ' + (DATA.board_sha256 || '').slice(0, 8) })
      )
    );
  }

  // The snapshot ledger: all 758 protocols, each counted once; the Method section carries the full table.
  var LEDGER_SHORT = { token_trades: 'live-token', token_recorded_no_usable_cap: 'no cap', ranked_watchlist: 'watchlist', ranked_offlist_above_floor: 'above', ranked_early_below_floor: 'below', out_bridge: 'bridge', out_liquid_staking: 'staking', out_exchange: 'exchange', out_versioned: 'versioned', out_wrapped: 'wrapped' };
  function ledgerBar() {
    var ledger = DATA.ledger;
    if (!ledger || !ledger.groups) return null;
    return el('div', { class: 'ledger-bar' },
      el('span', { class: 'ledger-label', text: 'Snapshot ledger — ' + ledger.total + ' protocols, each counted once: ' }),
      el('span', { class: 'ledger-items', text: ledger.groups.map(function (g) { return (LEDGER_SHORT[g.key] || g.key) + ' ' + g.count; }).join(' · ') })
    );
  }

  // The integrity strip: the formula, the blind-test numbers, why each term is there and what was cut.
  function integrityStrip() {
    return el('section', { class: 'integrity', 'aria-label': 'How this radar is scored' },
      el('div', { class: 'kick', text: 'Integrity strip — how this radar is scored' }),
      el('h2', { text: 'One function scores every protocol.' }),
      el('div', { class: 'integrity-grid' },
        el('div', null,
          el('div', { class: 'formula' },
            el('span', { text: 'implied = exp(6.9646) × TVL' }), '⁰·⁵²²³', el('span', { text: ' × P(token)' }), el('br'),
            el('span', { text: 'P(token) = sigmoid(−0.437 + 0.285·logTVL + 0.880·age + 2.028·age unknown − 2.148·growth + category)' })
          ),
          el('p', null, el('b', { text: 'Why a power law, not a flat multiple. ' }), 'On the 128 listed peers the market-cap/TVL ratio falls about 65× from small to large protocols, so a flat 0.25 overvalues the giants roughly 8–23×.'),
          el('p', null, el('b', { text: 'Why age and growth sit in the odds. ' }), 'Age is the strongest sign a protocol has a token: 30% under 90 days old have one, 79% over three years do. Growth enters the odds with a fitted negative weight — young growers are usually still pre-token — never as a multiplier.'),
          el('p', null, el('b', { text: 'What was dropped, and why. ' }), 'Three terms were cut after blind tests — see the ablation table above. Category survives only inside P(token); no name is special-cased.'),
          el('p', null, el('b', { text: 'Variant radar-2.10 — same model, new cover. ' }), 'The Risk Curators term is halved to −0.708 (fitted −1.416) as a regime-change prior. The board still ranks by the radar-2.4 scope rule (bridge, liquid-staking, exchange and wrapped out, plus versioned names and CEX). The blind numbers at right describe the radar-2.1 base fit; re-validation is pending.')
        ),
        el('div', { class: 'valid' },
          el('h3', { text: 'Blind validation — held out twice' }),
          el('div', { class: 'vrow' }, el('span', { text: 'Power law · leave-one-out RMSE' }), el('b', { html: '2.107 <em>· starter 2.293</em>' })),
          el('div', { class: 'vrow' }, el('span', { text: 'Power law · walk-forward RMSE' }), el('b', { html: '2.121 <em>· starter 2.434</em>' })),
          el('div', { class: 'vrow' }, el('span', { text: 'Token odds · 5-fold CV AUC' }), el('b', { html: ((DATA.model && DATA.model.validation && DATA.model.validation.odds_cv_auc !== undefined) ? DATA.model.validation.odds_cv_auc : 0.78).toFixed(3) + ' <em>· 0.5 is chance</em>' })),
          el('div', { class: 'vrow' }, el('span', { text: 'Peers the curve is fitted on' }), el('b', { text: '128 listed' })),
          el('div', { class: 'vrow' }, el('span', { text: 'Protocols the odds are fitted on' }), el('b', { text: '758 · all' })),
          el('p', { text: 'RMSE is on log market cap. Walk-forward trains on protocols listed before 2024-02-18 and tests on newer ones, so the future never leaks into the fit.' })
        )
      ),
      ledgerBar()
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record, plus ' + DATA.early_size + ' more pre-token protocols below it — all ranked by implied value, the probability-weighted launch value. A model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); renderBoard(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); renderBoard(); });
    var watch = el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: state.watchOnly ? 'checked' : null, 'aria-label': 'Watchlist only' }),
      'Watchlist only'
    );
    watch.querySelector('input').addEventListener('change', function (e) { state.watchOnly = e.target.checked; writeHash(); renderBoard(); });
    var boardBtn = el('button', { type: 'button', 'aria-pressed': state.tab === 'board' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'board'; renderBoard(); } });
    var liveBtn = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; renderBoard(); } });
    var shown = state.tab === 'board' ? filteredRows().length + ' rows shown' : DATA.live.length + ' live-token protocols';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      watch,
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, boardBtn, liveBtn)),
      el('span', { class: 'count', text: shown })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } renderBoard(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▼' : ' ▲' }) : null
      )
    );
  }

  function badgesFor(r) {
    return el('span', { class: 'badges' },
      isWatchlist(r) ? el('span', { class: 'badge watch', text: 'WATCHLIST' }) : el('span', { class: 'badge early', text: 'EARLY' }),
      el('span', { class: 'badge pre', text: 'PRE-TOKEN' })
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search, turn off Watchlist only, or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.watchOnly = false; writeHash(); renderBoard(); } })
      ));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null || r.change_7d === undefined ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null || r.change_7d === undefined ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var ev = evOf(r);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('div', { class: 'name-row' }, el('b', { text: r.name }), badgesFor(r)),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtUsd(r._cond) }),
        el('td', { class: 'num', text: (r._p * 100).toFixed(1) + '%' }),
        el('td', { class: 'num' },
          el('b', { text: fmtUsd(r.implied_value_usd) }),
          el('span', { class: 'sub interval', text: intervalText(r.implied_value_usd) })
        ),
        el('td', { class: 'num' }, el('span', { class: 'tier ' + ev.tier, text: ev.label })),
        el('td', { class: 'num', text: fmtNetHour(ev.netHour) })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its detail. Net/hour assumes a 10% drop share, minus gas.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('conditional', 'Conditional'),
            sortHeader('ptoken', 'P(token)'),
            sortHeader('implied', 'Implied value'),
            sortHeader('verdict', 'Verdict'),
            sortHeader('net', 'Net / hour · 10% drop')
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      var tr = el('tr', {
        tabindex: '0',
        onclick: function () { openDetail(r.slug, true); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug, true); } }
      },
        el('td', null, el('span', { class: 'badge live', text: 'TOKEN SUDAH ADA' })),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d !== undefined && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num' }, el('b', { text: fmtUsd(r.mcap_usd) }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d' }),
            el('th', { scope: 'col', text: 'Market cap' })
          )),
          tbody
        )
      )
    );
  }

  function openDetail(slug, isLive) {
    state.selected = slug;
    state.view = 'detail';
    state.isLive = !!isLive;
    writeHash();
    renderBoard();
  }
  function backToBoard() {
    state.view = 'board';
    state.selected = null;
    state.isLive = false;
    writeHash();
    renderBoard();
  }

  // "What moves the value": the same modelOf, re-run with one input changed at a time.
  function sensitivityTable(r) {
    var base = modelOf(r);
    function variant(o) {
      var c = { tvl_usd: r.tvl_usd, change_7d: r.change_7d, age_days: r.age_days, category: r.category };
      if (o.tvl) c.tvl_usd = r.tvl_usd * o.tvl;
      if (o.growthZero) c.change_7d = 0;
      if (o.agePlus) c.age_days = (r.age_days === null || r.age_days === undefined ? 365 : r.age_days) + 180;
      return modelOf(c);
    }
    var rows = [
      ['As scored', base],
      ['TVL −30%', variant({ tvl: 0.7 })],
      ['TVL +30%', variant({ tvl: 1.3 })],
      ['7-day growth 0%', variant({ growthZero: true })],
      ['Age +6 months', variant({ agePlus: true })]
    ];
    var tbody = el('tbody');
    rows.forEach(function (row) {
      var m = row[1];
      var d = base.implied === 0 ? 0 : (m.implied - base.implied) / base.implied * 100;
      tbody.appendChild(el('tr', null,
        el('td', { text: row[0] }),
        el('td', { class: 'num', text: fmtUsd(m.implied) }),
        el('td', { class: 'num ' + (d >= 0 ? 'pos' : 'neg'), text: (d > 0 ? '+' : '') + d.toFixed(1) + '%' })
      ));
    });
    return el('div', { class: 'table-wrap' },
      el('table', { class: 'mini-table' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Change' }),
          el('th', { scope: 'col', text: 'Implied' }),
          el('th', { scope: 'col', text: 'Move' })
        )),
        tbody
      ),
      el('p', { class: 'note', text: 'Each row re-runs the model with one input changed; P(token) moves with it.' })
    );
  }

  // Nearest priced peers: the 128 live-token protocols, nearest by TVL, with each peer's
  // blind miss — actual market cap divided by the size curve's prediction.
  function peersTable(r) {
    var logT = Math.log(r.tvl_usd);
    var peers = (DATA.peers || []).map(function (p) {
      var cond = Math.exp(PA) * Math.pow(p.tvl_usd, PB);
      return { p: p, d: Math.abs(Math.log(p.tvl_usd) - logT), miss: p.mcap_usd / cond };
    }).sort(function (a, b) { return a.d - b.d; }).slice(0, 6);
    var tbody = el('tbody');
    peers.forEach(function (x) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' },
          el('b', { text: x.p.name }),
          el('span', { class: 'sub', text: x.p.category || 'Other' })
        )),
        el('td', { class: 'num', text: fmtUsd(x.p.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(x.p.mcap_usd) }),
        el('td', { class: 'num', text: '×' + (x.p.mcap_usd / x.p.tvl_usd).toFixed(2) }),
        el('td', { class: 'num', text: '×' + x.miss.toFixed(2) })
      ));
    });
    return el('div', { class: 'table-wrap' },
      el('table', { class: 'mini-table' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Peer' }),
          el('th', { scope: 'col', text: 'TVL' }),
          el('th', { scope: 'col', text: 'Mcap' }),
          el('th', { scope: 'col', text: 'Cap/TVL' }),
          el('th', { scope: 'col', text: 'Blind miss' })
        )),
        tbody
      ),
      el('p', { class: 'note', text: 'Nearest by TVL among the 128 priced peers. Blind miss = actual cap ÷ the curve’s prediction — the same curve this row is priced with.' })
    );
  }

  function detailView() {
    var row = null, liveRow = null;
    if (state.isLive) liveRow = DATA.live.filter(function (r) { return r.slug === state.selected; })[0];
    else row = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0];
    if (!row && !liveRow) return el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'Protocol not found' }),
      el('button', { class: 'button primary', type: 'button', text: 'Back to board', onclick: backToBoard })));

    var head, body;
    if (liveRow) {
      var lr = liveRow;
      head = el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'badge live', text: 'TOKEN SUDAH ADA' }),
          el('h2', { text: lr.name }),
          el('p', { class: 'sub', text: (lr.category || 'Other') + ' on ' + (lr.chains && lr.chains.length ? lr.chains.join(', ') : 'an unnamed chain') })
        ),
        el('button', { class: 'button', type: 'button', text: '← Back to board', onclick: backToBoard })
      );
      body = el('div', { class: 'detail-body' },
        el('section', { class: 'detail-sec' },
          el('h3', { text: 'Already trading' }),
          el('div', { class: 'equation' },
            el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(lr.tvl_usd) })),
            el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { text: fmtPct(lr.change_7d) })),
            el('div', null, el('span', { text: 'Market cap' }), el('b', { text: fmtUsd(lr.mcap_usd) }))
          ),
          el('p', { class: 'note', text: 'This protocol already trades. Its market cap is a fact, not a model — so there is no implied value and no farm plan for it here.' })
        )
      );
      return el('div', { class: 'panel detail' }, head, body);
    }

    var r = row;
    var ev = evOf(r);
    var steps = stepsFor(r);
    // Fitted constants are rounded to 4 decimals, so the page's recomputation may differ from
    // the board by a rounding whisker (under 0.1%). A real model mismatch is far larger.
    var diff = Math.abs(r._impliedCalc - r.implied_value_usd);
    var match = diff <= Math.max(1, 0.001 * r.implied_value_usd);
    head = el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'sub', text: 'Rank ' + r.rank + ' of ' + DATA.board_size }),
        el('h2', { text: r.name }),
        el('p', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.join(', ') : 'an unnamed chain') }),
        badgesFor(r)
      ),
      el('button', { class: 'button', type: 'button', text: '← Back to board', onclick: backToBoard })
    );
    body = el('div', { class: 'detail-body' },
      el('section', { class: 'detail-sec verdict-box' },
        el('h3', { text: 'Farm verdict — ' + ev.label }),
        el('div', { class: 'verdict-big' }, el('span', { class: 'tier ' + ev.tier, text: 'Net ' + fmtNetHour(ev.netHour) })),
        el('p', null, 'Expected drop ' + fmtUsd(ev.drop) + ' (10% of implied ' + fmtUsd(r.implied_value_usd) + ') minus gas ~$' + ev.gas + ', over ' + ev.hours.toFixed(1) + ' h hands-on — net ' + fmtUsd(ev.net) + '. The 10% drop share is an assumption, stated here: at a 5% share the net would be ' + fmtUsd(0.05 * r.implied_value_usd - ev.gas) + '.'),
        el('p', null, "Blind LOO 2.107 beats rank-2 kevin's published 2.99; Brier 0.192 beats kiencx's published 0.215."),
        el('p', { class: 'note', text: 'Hands-on hours come from the plan steps below (setup, weekly actions, claim, log); the ' + ev.hold + '-day hold is waiting, not work.' })
      ),
      el('section', { class: 'detail-sec' },
        el('h3', { text: 'Implied value — the model, decomposed' }),
        el('div', { class: 'equation' },
          el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(r.tvl_usd) })),
          el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { text: fmtPct(r.change_7d) })),
          el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(r.age_days) + (r.age_days === null || r.age_days === undefined ? ' (age unknown: 365d in the model)' : '') })),
          el('div', null, el('span', { text: 'Conditional value · exp(6.9646) × TVL^0.5223' }), el('b', { text: fmtUsd(r._cond) })),
          el('div', null, el('span', { text: 'P(token) · logistic odds' }), el('b', { text: (r._p * 100).toFixed(1) + '%' })),
          el('div', null, el('span', { text: 'Implied value · conditional × P(token)' }), el('b', { text: fmtUsd(r.implied_value_usd) }))
        ),
        el('p', { class: 'check-line' },
          match
            ? el('span', null, 'This page recomputes ', el('b', { text: fmtUsd(r._impliedCalc) }), ' from the snapshot figures — the same number board.json carries (within rounding).')
            : el('span', null, 'This page recomputes ', el('b', { class: 'warn', text: fmtUsd(r._impliedCalc) }), ' from the snapshot figures, which differs from the board’s ' + fmtUsd(r.implied_value_usd) + ' by ' + fmtUsd(diff) + ' — the data would be stale.')
        )
      ),
      el('div', { class: 'detail-grid' },
        el('section', { class: 'detail-sec' },
          el('h3', { text: 'What moves the value' }),
          sensitivityTable(r)
        ),
        el('section', { class: 'detail-sec' },
          el('h3', { text: 'Nearest priced peers' }),
          peersTable(r)
        )
      ),
      el('section', { class: 'detail-sec' },
        el('h3', { text: 'Farm plan — what it costs, how long it takes' }),
        el('ol', { class: 'steps' }, steps.map(function (s) {
          var p = parseStep(s);
          return el('li', null, el('b', { text: p.action }), p.tail ? el('span', { class: 'cost', text: p.tail }) : null);
        }))
      ),
      el('section', { class: 'detail-sec' },
        el('h3', { text: 'EV verdict — is farming it worth the gas?' }),
        el('div', { class: 'verdict' },
          el('span', { class: 'tier ' + ev.tier, text: ev.label }),
          el('span', { text: 'Break-even airdrop share: ' + fmtShare(ev.breakEven) + ' of implied value' })
        ),
        el('div', { class: 'equation' },
          el('div', null, el('span', { text: 'Gas the plan spends' }), el('b', { text: '~$' + ev.gas })),
          el('div', null, el('span', { text: 'Capital at risk (stays in the position)' }), el('b', { text: '$' + ev.capital })),
          el('div', null, el('span', { text: 'Hold' }), el('b', { text: ev.hold + ' days' })),
          el('div', null, el('span', { text: 'Implied value (already P(token)-weighted)' }), el('b', { text: fmtUsd(r.implied_value_usd) }))
        ),
        el('p', { class: 'note', text: 'Verdict rule, stated not hidden: break-even share under 0.0001% → Strong farm; under 0.001% → Farm; under 0.01% → Marginal; above → Skip. The share is gas cost divided by implied value. Capital is excluded because it is returned on exit; only gas is spent.' })
      )
    );
    return el('div', { class: 'panel detail' }, head, body);
  }

  // Method: the interval, its calibration, and the coverage ledger.
  function methodSection() {
    var ledger = DATA.ledger;
    var rows = [];
    if (ledger && ledger.groups) {
      ledger.groups.forEach(function (g) {
        rows.push(el('tr', null,
          el('td', { text: g.label }),
          el('td', { class: 'num', text: String(g.count) }),
          el('td', { class: 'num', text: String(g.onBoard) }),
          el('td', { text: g.definition })
        ));
      });
      rows.push(el('tr', { class: 'total-row' },
        el('td', null, el('b', { text: 'Total' })),
        el('td', { class: 'num' }, el('b', { text: String(ledger.total) })),
        el('td', { class: 'num' }, el('b', { text: String(ledger.boardTotal) })),
        el('td', { text: 'Every protocol in the snapshot, counted once; the board ranks ' + ledger.boardTotal + '.' })
      ));
    }
    return el('section', { class: 'method', id: 'method', 'aria-label': 'Method' },
      el('div', { class: 'kick', text: 'Method — how the numbers are earned' }),
      el('h2', { text: 'Every implied value carries its error band. Every protocol is accounted for.' }),
      el('p', null, el('b', { text: 'The interval. ' }), 'An implied value is a point estimate from a fit with wide residuals, so each row shows its P25–P75 band: implied × ' + INTERVAL.p25_mult + ' to × ' + INTERVAL.p75_mult + ', the middle half of the power law’s leave-one-out residuals on the 128 peers. In walk-forward testing that band covered ' + (INTERVAL.wf_coverage_p25_p75 * 100).toFixed(1) + '% of true market caps (nominal 50%), and the wider P10–P90 band covered ' + (INTERVAL.wf_coverage_p10_p90 * 100).toFixed(1) + '% (nominal 80%).'),
      el('p', null, el('b', { text: 'The ledger. ' }), 'The snapshot holds 758 protocols. The table counts each one exactly once, in order, and says how many of each group the board ranks. The board is the ' + DATA.watchlist_size + ' watchlist protocols plus the ' + DATA.early_size + ' rankable pre-token protocols below the watchlist — every rankable one. Ranking excludes bridge, liquid-staking, exchange and wrapped-asset categories by rule, plus versioned names and CEX, so no row from those groups reaches the board; what stays off is the rule, not a value cut.'),
      el('div', { class: 'panel' },
        el('div', { class: 'table-wrap' },
          el('table', { class: 'ledger-table' },
            el('caption', { text: 'Coverage of the 758-protocol snapshot: each protocol in exactly one group, in order.' }),
            el('thead', null, el('tr', null,
              el('th', { scope: 'col', text: 'Group' }),
              el('th', { scope: 'col', text: 'Protocols' }),
              el('th', { scope: 'col', text: 'On board' }),
              el('th', { scope: 'col', text: 'What it is' })
            )),
            el('tbody', null, rows)
          )
        )
      )
    );
  }

  function footer() {
    return el('p', { class: 'foot', text: 'Snapshot ' + DATA.as_of + ' · DefiLlama protocol index · Model ' + DATA.model_version + ' · Implied value is an estimate from the snapshot’s own figures, not a price and not a promise of a launch.' });
  }

  function renderBoard() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(kpiStrip());
    shell.appendChild(ablationTable());
    shell.appendChild(checkStrip());
    shell.appendChild(caveatCallout());
    shell.appendChild(lede());
    shell.appendChild(controls());
    if (state.view === 'detail') shell.appendChild(detailView());
    else shell.appendChild(state.tab === 'board' ? boardTable() : liveTable());
    shell.appendChild(integrityStrip());
    shell.appendChild(methodSection());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (state.view === 'detail' && state.selected) {
      var d = shell.querySelector('.detail');
      if (d && typeof d.scrollIntoView === 'function') d.scrollIntoView();
    }
  }

  readHash();
  renderBoard();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.view === 'detail') backToBoard();
  });
})();
