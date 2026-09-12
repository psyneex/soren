/**
 * Server-rendered HTML for the monitoring UI. No business logic here — the
 * page only calls the API endpoints and renders their responses. The manual
 * input contract is exactly: token address + up to three Smart Money wallets;
 * every numeric value shown comes from providers (normalized internally).
 */
import { formatCompactNumber, formatUsdAmount } from './numeric.js';
import type { WatchlistToken } from '../store/types.js';

const STYLES = `
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 32px; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { margin-bottom: 4px; }
    .sub { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
    form, .panel { background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
    label { display: block; font-size: 12px; margin-bottom: 8px; color: #cbd5e1; }
    input, select, button { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid #475569; background: #020817; color: #f8fafc; padding: 10px 12px; font: inherit; }
    button { margin-top: 20px; cursor: pointer; background: #2563eb; border: none; font-weight: 600; padding: 12px; }
    button.secondary { background: #1e293b; }
    button:disabled { opacity: 0.6; cursor: wait; }
    .hint { color: #94a3b8; font-size: 12px; margin-top: 6px; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; }
    .actions button { flex: 1 1 200px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
    th { color: #94a3b8; font-weight: 500; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge.NEW { background: #334155; color: #cbd5e1; }
    .badge.WATCH { background: #713f12; color: #fde68a; }
    .badge.BUY_CANDIDATE { background: #14532d; color: #86efac; }
    .badge.ACTIVE_WATCH { background: #1e3a8a; color: #93c5fd; }
    .badge.HOLD { background: #312e81; color: #c7d2fe; }
    .badge.TAKE_PROFIT { background: #064e3b; color: #6ee7b7; }
    .badge.STOP_LOSS, .badge.EXIT, .badge.INVALIDATED { background: #450a0a; color: #fca5a5; }
    .badge.PAUSED { background: #1f2937; color: #9ca3af; }
    .badge.SCORED { background: #14532d; color: #86efac; }
    .badge.INCOMPLETE { background: #713f12; color: #fde68a; }
    .badge.FAILED { background: #450a0a; color: #fca5a5; }
    .badge.OK { background: #14532d; color: #86efac; }
    .badge.UNAVAILABLE { background: #713f12; color: #fde68a; }
    .badge.HEALTHY { background: #14532d; color: #86efac; }
    .badge.DEGRADED { background: #713f12; color: #fde68a; }
    .badge.UNKNOWN { background: #334155; color: #cbd5e1; }
    .badge.IGNORE { background: #334155; color: #cbd5e1; }
    .chip { display: inline-block; background: #450a0a; color: #fca5a5; border-radius: 6px; padding: 1px 7px; font-size: 11px; margin: 1px 2px; }
    .chip.wait { background: #713f12; color: #fde68a; }
    .score-num { font-size: 42px; font-weight: 700; }
    .score-num.incomplete { font-size: 24px; color: #fca5a5; }
    .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 12px; }
    .kv .item { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 8px 10px; }
    .kv .item .key { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    .kv .item .val { font-size: 14px; margin-top: 4px; word-break: break-all; }
    .note { color: #94a3b8; font-size: 12px; margin-top: 4px; }
    .error { background: #450a0a; border: 1px solid #7f1d1d; color: #fca5a5; border-radius: 10px; padding: 14px; margin-top: 16px; }
    .success { background: #052e16; border: 1px solid #166534; color: #86efac; border-radius: 10px; padding: 14px; margin-top: 16px; }
    a { color: #93c5fd; }
    .muted { color: #64748b; font-size: 12px; }
`;

const BASE_HEAD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Soren — Token Monitoring</title>
  <style>${STYLES}</style>
</head>`;

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CHAIN_OPTIONS = ['solana', 'ethereum', 'polygon', 'arbitrum', 'base', 'bsc']
  .map((chain) => `<option value="${chain}"${chain === 'solana' ? ' selected' : ''}>${chain}${chain === 'solana' ? ' (default)' : ''}</option>`)
  .join('');

export function renderAppPage(): string {
  return `${BASE_HEAD}
<body>
<div class="container">
  <h1>Token Monitoring</h1>
  <p class="sub">Enter a token address and up to three Smart Money wallets. Everything else — price, liquidity, volume, market cap, flows, holders — is retrieved and scored automatically by the Golden Formula.</p>

  <form id="addForm">
    <div class="grid">
      <div>
        <label for="chain">Chain</label>
        <select id="chain">${CHAIN_OPTIONS}</select>
      </div>
      <div>
        <label for="tokenAddress">Token address (mint / contract)</label>
        <input id="tokenAddress" placeholder="e.g. JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" required />
      </div>
      <div>
        <label for="wallet1">Smart Money Wallet 1 (required)</label>
        <input id="wallet1" placeholder="Wallet address from Nansen research" required />
      </div>
      <div>
        <label for="wallet2">Smart Money Wallet 2 (optional)</label>
        <input id="wallet2" placeholder="Wallet address" />
      </div>
      <div>
        <label for="wallet3">Smart Money Wallet 3 (optional)</label>
        <input id="wallet3" placeholder="Wallet address" />
      </div>
    </div>
    <div class="actions">
      <button type="button" id="previewBtn">Preview evaluation</button>
      <button type="submit" id="addBtn">Add to watchlist</button>
    </div>
    <p class="hint">Preview runs the full pipeline without persisting. Adding to the watchlist starts periodic monitoring, snapshot storage, signal detection and Telegram alerts.</p>
  </form>

  <div id="result"></div>

  <div class="panel">
    <h2 style="margin-top:0">Monitoring status</h2>
    <div id="monitoringStatus">Loading…</div>
  </div>

  <div class="panel">
    <h2 style="margin-top:0">Watchlist</h2>
    <div id="watchlist">Loading…</div>
  </div>

  <p class="muted">Golden Formula V0 · thresholds are experimental · research-only, no trade execution.</p>
</div>
<script>
(function () {
  var resultEl = document.getElementById('result');
  var listEl = document.getElementById('watchlist');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function badge(text) { return '<span class="badge ' + esc(text) + '">' + esc(text) + '</span>'; }

  function shortAddr(a) { a = String(a || ''); return a.length > 14 ? a.slice(0, 8) + '…' + a.slice(-6) : a; }

  function num(v) { return v == null ? '—' : Number(v).toFixed(2); }

  function readForm() {
    return {
      chain: document.getElementById('chain').value,
      tokenAddress: document.getElementById('tokenAddress').value.trim(),
      smartMoneyWallet1: document.getElementById('wallet1').value.trim(),
      smartMoneyWallet2: document.getElementById('wallet2').value.trim(),
      smartMoneyWallet3: document.getElementById('wallet3').value.trim()
    };
  }

  async function api(method, url, body) {
    var response = await fetch(url, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var detail = data && data.issues ? data.issues.map(function (i) { return i.message; }).join('; ') : (data && data.error) || ('HTTP ' + response.status);
      throw new Error(detail);
    }
    return data;
  }

  function renderEvaluation(result) {
    var html = [];
    html.push('<div class="panel">');
    html.push('<h2 style="margin-top:0">Evaluation — ' + esc(result.symbol || shortAddr(result.tokenAddress)) + ' <span class="muted">(' + esc(result.chain) + ')</span></h2>');
    html.push('<div class="kv">');
    html.push('<div class="item"><div class="key">Status</div><div class="val">' + badge(result.status) + '</div></div>');
    html.push('<div class="item"><div class="key">Golden Score</div><div class="val">' + (result.score != null ? '<span class="score-num">' + num(result.score) + '</span>' : '<span class="score-num incomplete">INCOMPLETE</span>') + '</div></div>');
    html.push('<div class="item"><div class="key">Interpretation</div><div class="val">' + esc(result.interpretation || '—') + '</div></div>');
    html.push('<div class="item"><div class="key">Risk Gates</div><div class="val">' + badge(result.gatesVerdict || 'n/a') + '</div></div>');
    html.push('<div class="item"><div class="key">State</div><div class="val">' + badge(result.state) + (result.stateChanged ? ' <span class="muted">(changed from ' + esc(result.previousState) + ')</span>' : '') + '</div></div>');
    html.push('</div>');
    if (result.missing && result.missing.length) {
      html.push('<p class="note">Missing inputs (score withheld): ' + esc(result.missing.join(', ')) + '</p>');
    }
    if (result.notes && result.notes.length) {
      html.push('<p class="note">' + result.notes.map(esc).join('<br/>') + '</p>');
    }
    html.push('</div>');
    resultEl.innerHTML = html.join('');
  }

  function renderWatchlist(tokens) {
    if (!tokens.length) {
      listEl.innerHTML = '<p class="note">Watchlist is empty — add a token above.</p>';
      return;
    }
    var rows = tokens.map(function (entry) {
      var latest = entry.latestSnapshot;
      var evalBadge = latest ? badge(latest.evaluationStatus) : '<span class="muted">not yet observed</span>';
      var observed = latest ? new Date(latest.observedAt).toLocaleString() : '—';
      var state = entry.status === 'PAUSED' ? badge('PAUSED') : badge(entry.currentState);
      var toggle = entry.status === 'PAUSED'
        ? '<button data-resume="' + esc(entry.id) + '" style="margin:0;padding:6px 10px;font-size:12px">Resume</button>'
        : '<button data-pause="' + esc(entry.id) + '" style="margin:0;padding:6px 10px;font-size:12px">Pause</button>';
      return '<tr>' +
        '<td><a href="/watchlist/' + esc(entry.id) + '/view">' + esc(entry.symbol || shortAddr(entry.tokenAddress)) + '</a><br/><span class="muted">' + shortAddr(entry.tokenAddress) + '</span></td>' +
        '<td>' + esc(entry.chain) + '</td>' +
        '<td>' + state + '</td>' +
        '<td>' + (latest && latest.score != null ? num(latest.score) : '—') + '</td>' +
        '<td>' + evalBadge + (latest && latest.missingInputs && latest.missingInputs.length ? '<br/><span class="muted">missing: ' + esc(latest.missingInputs.join(', ')) + '</span>' : '') + '</td>' +
        '<td>' + observed + '</td>' +
        '<td>' +
          '<button data-evaluate="' + esc(entry.id) + '" style="margin:0;padding:6px 10px;font-size:12px">Evaluate now</button> ' +
          toggle +
        '</td>' +
      '</tr>';
    }).join('');
    listEl.innerHTML = '<table><thead><tr><th>Token</th><th>Chain</th><th>State</th><th>Score</th><th>Latest eval</th><th>Observed</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>';

    listEl.querySelectorAll('[data-evaluate]').forEach(function (button) {
      button.addEventListener('click', async function () {
        button.disabled = true;
        try {
          var data = await api('POST', '/watchlist/' + button.getAttribute('data-evaluate') + '/evaluate');
          renderEvaluation(data.result);
          await loadWatchlist();
        } catch (error) {
          resultEl.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
        }
        button.disabled = false;
      });
    });
    listEl.querySelectorAll('[data-pause]').forEach(function (button) {
      button.addEventListener('click', async function () {
        await api('PATCH', '/watchlist/' + button.getAttribute('data-pause'), { status: 'PAUSED' });
        await loadWatchlist();
      });
    });
    listEl.querySelectorAll('[data-resume]').forEach(function (button) {
      button.addEventListener('click', async function () {
        await api('PATCH', '/watchlist/' + button.getAttribute('data-resume'), { status: 'ACTIVE' });
        await loadWatchlist();
      });
    });
  }

  function when(v) { return v == null ? '—' : new Date(v).toLocaleString(); }

  function waitChip(component, accelerationReadyAt, nextTickAt) {
    var heals = component === 'accumulationAcceleration' || component === 'marketRegime' || component === 'relativeStrength';
    var ready = accelerationReadyAt != null && Date.parse(accelerationReadyAt) <= Date.parse(nextTickAt);
    return '<span class="chip' + (heals ? ' wait' : '') + '">' + esc(component) + (heals && !ready ? ' ⏳' : '') + '</span>';
  }

  async function loadMonitoringStatus() {
    var statusEl = document.getElementById('monitoringStatus');
    try {
      var data = await api('GET', '/monitoring-status');
      var providers = data.providers || {};
      var rows = (data.tokens || []).map(function (entry) {
        var missing = (entry.missingInputs || []).map(function (component) {
          return waitChip(component, entry.accelerationReadyAt, data.nextTickAt);
        }).join(' ') || '<span class="muted">none</span>';
        return '<tr>' +
          '<td><a href="/watchlist/' + esc(entry.tokenId) + '/view">' + esc(entry.symbol || shortAddr(entry.tokenAddress)) + '</a></td>' +
          '<td>' + badge(entry.currentState) + '</td>' +
          '<td>' + when(entry.lastObservedAt) + '</td>' +
          '<td>' + (entry.lastEvaluationStatus ? badge(entry.lastEvaluationStatus) : '<span class="muted">none yet</span>') + '</td>' +
          '<td>' + (entry.lastScore != null ? num(entry.lastScore) : '—') + '</td>' +
          '<td>' + badge(entry.scoreExpectedNext) + '</td>' +
          '<td>' + missing + '</td>' +
          '</tr>';
      }).join('');
      var regimeNotes = (providers.regimeNotes || []).length
        ? '<p class="note">Regime provider: ' + (providers.regimeNotes || []).map(esc).join(' · ') + '</p>'
        : '';
      var tokenNotes = (data.tokens || []).filter(function (entry) { return (entry.notes || []).length > 0; })
        .map(function (entry) { return '<p class="note">' + esc(entry.symbol || shortAddr(entry.tokenAddress)) + ': ' + (entry.notes || []).map(esc).join(' ') + '</p>'; })
        .join('');
      statusEl.innerHTML =
        '<p class="hint" style="margin-top:0">Last derived ' + when(data.generatedAt) + ' · next cron tick <strong>' + when(data.nextTickAt) + '</strong> · ' + esc(data.cronSchedule) + '</p>' +
        '<div class="kv">' +
          '<div class="item"><div class="key">On-chain enrichment</div><div class="val">' + esc(providers.enrichment || '—') + '</div></div>' +
          '<div class="item"><div class="key">Market data</div><div class="val">' + esc(providers.market || '—') + '</div></div>' +
          '<div class="item"><div class="key">Regime reference</div><div class="val">' + esc(providers.regime || 'none') + '</div></div>' +
          '<div class="item"><div class="key">Regime health</div><div class="val">' + badge(providers.regimeHealth) + '</div></div>' +
        '</div>' + regimeNotes +
        '<table style="margin-top:12px"><thead><tr><th>Token</th><th>State</th><th>Last observed</th><th>Last evaluation</th><th>Score</th><th>Next score</th><th>Missing now</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="7" class="note">Watchlist is empty.</td></tr>') + '</tbody></table>' +
        '<p class="muted">⏳ marks a gap that self-heals by waiting (history/provider gaps) — e.g. accumulation acceleration needs a prior snapshot at least 1h old. Red chips without ⏳ need data to become available.</p>' +
        tokenNotes;
    } catch (error) {
      statusEl.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
    }
  }

  async function loadWatchlist() {
    try {
      var data = await api('GET', '/watchlist');
      renderWatchlist(data.tokens || []);
    } catch (error) {
      listEl.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
    }
  }

  document.getElementById('previewBtn').addEventListener('click', async function () {
    this.disabled = true;
    resultEl.innerHTML = '<div class="panel">Evaluating…</div>';
    try {
      var data = await api('POST', '/evaluate', readForm());
      renderEvaluation(data);
    } catch (error) {
      resultEl.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
    }
    this.disabled = false;
  });

  document.getElementById('addForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    var button = document.getElementById('addBtn');
    button.disabled = true;
    try {
      var data = await api('POST', '/watchlist', readForm());
      resultEl.innerHTML = '<div class="success">' + esc(data.status === 'exists' ? 'Token is already on the watchlist.' : 'Token added to the watchlist — monitoring will pick it up on the next cycle (or use "Evaluate now").') + '</div>';
      await loadWatchlist();
    } catch (error) {
      resultEl.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
    }
    button.disabled = false;
  });

  loadWatchlist();
  loadMonitoringStatus();
})();
</script>
</body>
</html>`;
}

export function renderWatchDetailPage(token: WatchlistToken): string {
  return `${BASE_HEAD}
<body>
<div class="container">
  <h1>${esc(token.symbol || token.tokenAddress)} <span class="muted" style="font-size:16px">${esc(token.chain)} · ${esc(token.tokenAddress)}</span></h1>
  <p class="sub">State <span class="badge ${esc(token.currentState)}">${esc(token.currentState)}</span> · status ${esc(token.status)} · entered the watchlist ${esc(new Date(token.createdAt).toLocaleString())}</p>

  <div class="panel">
    <h2 style="margin-top:0">Smart Money wallets</h2>
    <div class="kv">
      ${(token.smartMoneyWallets || []).map((wallet) => `<div class="item"><div class="key">Wallet</div><div class="val">${esc(wallet)}</div></div>`).join('')}
    </div>
  </div>

  <div class="panel">
    <h2 style="margin-top:0">Latest evaluation — Golden Formula components</h2>
    <div id="components">Loading…</div>
  </div>

  <div class="panel"><h2 style="margin-top:0">Signal history</h2><div id="signals">Loading…</div></div>
  <div class="panel"><h2 style="margin-top:0">Episode outcomes (triple barrier)</h2><div id="outcomes">Loading…</div></div>
  <div class="panel"><h2 style="margin-top:0">Market snapshots (latest 50, immutable)</h2><div id="snapshots">Loading…</div></div>
  <p class="muted"><a href="/">← Back to watchlist</a></p>
</div>
<script>
(function () {
  var TOKEN_ID = ${JSON.stringify(token.id)};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function badge(text) { return '<span class="badge ' + esc(text) + '">' + esc(text) + '</span>'; }
  function num(v, digits) { return v == null ? '—' : Number(v).toFixed(digits == null ? 2 : digits); }
  function when(v) { return v == null ? '—' : new Date(v).toLocaleString(); }

  async function api(url) {
    var response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function load() {
    try {
      var detail = await api('/watchlist/' + TOKEN_ID);

      var latest = (detail.snapshots || [])[0] || null;
      var componentsHtml = '';
      if (latest) {
        var components = (latest.features || {}).components || {};
        var names = ['smartMoneyAccumulation', 'accumulationAcceleration', 'relativeStrength', 'volumeConfirmation', 'marketRegime'];
        componentsHtml = names.map(function (name) {
          var component = components[name] || {};
          var notes = (component.notes || []).map(esc).join('<br>');
          return '<div class="item"><div class="key">' + esc(name) + '</div>' +
            '<div class="val">' + (component.value != null ? num(component.value) : '—') + ' ' + badge(component.status || 'UNAVAILABLE') + '</div>' +
            (notes ? '<div class="note">' + notes + '</div>' : '') +
            '</div>';
        }).join('');
        componentsHtml =
          '<p class="hint" style="margin-top:0">Snapshot ' + when(latest.observedAt) + ' · evaluation ' + badge(latest.evaluationStatus) +
          ' · score <strong>' + (latest.score != null ? num(latest.score) : '—') + '</strong> · source ' + esc(latest.source) + '</p>' +
          '<div class="kv">' + componentsHtml + '</div>' +
          ((latest.missingInputs || []).length
            ? '<p class="note">Missing: ' + (latest.missingInputs || []).map(esc).join(', ') +
              ' — an INCOMPLETE evaluation never invents a score; the components below explain each gap.</p>'
            : '');
      } else {
        componentsHtml = '<p class="note">No snapshots yet — the worker observes every ACTIVE token once per interval. The first evaluation is expected INCOMPLETE (accumulation acceleration needs a prior snapshot at least 1h old).</p>';
      }
      document.getElementById('components').innerHTML = componentsHtml;

      var signals = (detail.signals || []).map(function (signal) {
        var evidence = signal.evidence || {};
        return '<tr><td>' + when(signal.generatedAt) + '</td><td>' + esc(signal.fromState || '—') + ' → ' + badge(signal.toState) +
          '</td><td>' + num(signal.score) + '</td><td>' + esc(signal.formulaVersion || '—') +
          '</td><td class="note">' + esc(evidence.reason || '') + '</td></tr>';
      }).join('');
      document.getElementById('signals').innerHTML = signals
        ? '<table><thead><tr><th>When</th><th>Transition</th><th>Score</th><th>Formula</th><th>Reason</th></tr></thead><tbody>' + signals + '</tbody></table>'
        : '<p class="note">No state transitions yet.</p>';

      var outcomes = (detail.outcomes || []).map(function (outcome) {
        return '<tr><td>' + when(outcome.entryAt) + '</td><td>' + num(outcome.entryPrice, 8) + '</td><td>' + badge(outcome.status) +
          '</td><td>' + num(outcome.mfePct) + '%</td><td>' + num(outcome.maePct) + '%</td><td>' + num(outcome.returnPct) + '%</td>' +
          '<td>' + num(outcome.timeToOutcomeMinutes, 0) + ' min</td><td>' + esc(outcome.paramsVersion) + '</td></tr>';
      }).join('');
      document.getElementById('outcomes').innerHTML = outcomes
        ? '<table><thead><tr><th>Entry</th><th>Entry price</th><th>Status</th><th>MFE</th><th>MAE</th><th>Return</th><th>Time to outcome</th><th>Params</th></tr></thead><tbody>' + outcomes + '</tbody></table>'
        : '<p class="note">No tracked episodes yet — outcomes are recorded for every BUY CANDIDATE.</p>';

      var snapshots = (detail.snapshots || []).map(function (snapshot) {
        var metrics = snapshot.metrics || {};
        var gates = (snapshot.gateResults || []).map(function (gate) {
          return esc(gate.gate) + '=' + esc(gate.verdict);
        }).join(', ');
        return '<tr><td>' + when(snapshot.observedAt) + '</td><td>' + badge(snapshot.evaluationStatus) + '</td>' +
          '<td>' + (snapshot.score != null ? num(snapshot.score) : '—') + '</td><td>' + badge(snapshot.signal) + '</td>' +
          '<td class="note">' + ((snapshot.missingInputs || []).map(esc).join(', ') || '—') + '</td>' +
          '<td>' + num(metrics.priceUsd, 8) + '</td><td>' + num(metrics.liquidityUsd, 0) + '</td>' +
          '<td>' + num(metrics.volume24hUsd, 0) + '</td><td>' + esc(snapshot.source) + '</td>' +
          '<td class="note">' + (gates || '—') + '</td></tr>';
      }).join('');
      document.getElementById('snapshots').innerHTML = snapshots
        ? '<table><thead><tr><th>Observed</th><th>Status</th><th>Score</th><th>Signal</th><th>Missing</th><th>Price</th><th>Liquidity</th><th>Volume 24h</th><th>Source</th><th>Gates</th></tr></thead><tbody>' + snapshots + '</tbody></table>'
        : '<p class="note">No snapshots yet — the worker observes every ACTIVE token once per interval.</p>';
    } catch (error) {
      document.getElementById('signals').innerHTML = '<div class="error">' + esc(error.message) + '</div>';
    }
  }

  load();
})();
</script>
</body>
</html>`;
}

