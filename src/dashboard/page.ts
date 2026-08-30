export function renderDashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="Local, read-only explorer for verified Antibody proof receipts.">
  <title>Antibody Proof Ledger</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --ink: #f4f1e8;
      --muted: #9a9b95;
      --dim: #686b68;
      --ground: #090b0b;
      --surface: #111414;
      --raised: #171b1a;
      --line: #292e2c;
      --line-bright: #3b423f;
      --verified: #7ce3b1;
      --verified-soft: #16382a;
      --rejected: #ff8878;
      --rejected-soft: #3b201f;
      --inconclusive: #e6bd6a;
      --inconclusive-soft: #382e19;
      --accent: #b5f4d4;
      --radius: 16px;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html { background: var(--ground); }
    body {
      min-width: 320px;
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% -8%, #163d2d 0, transparent 27rem),
        radial-gradient(circle at 86% 5%, #292315 0, transparent 24rem),
        var(--ground);
    }
    body::before {
      position: fixed;
      inset: 0;
      z-index: -1;
      content: "";
      opacity: .18;
      pointer-events: none;
      background-image: linear-gradient(#ffffff06 1px, transparent 1px), linear-gradient(90deg, #ffffff06 1px, transparent 1px);
      background-size: 38px 38px;
      mask-image: linear-gradient(to bottom, black, transparent 74%);
    }
    button, input { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    a { color: inherit; }
    .skip-link {
      position: fixed;
      top: .75rem;
      left: .75rem;
      z-index: 20;
      padding: .65rem .9rem;
      color: var(--ground);
      background: var(--ink);
      border-radius: 8px;
      transform: translateY(-180%);
    }
    .skip-link:focus { transform: translateY(0); }
    .shell { width: min(1540px, 100%); margin: 0 auto; padding: 26px; }
    .masthead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 24px;
    }
    .brand { display: flex; align-items: center; gap: 13px; min-width: 0; }
    .mark {
      display: grid;
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      place-items: center;
      color: var(--ground);
      font-size: 21px;
      font-weight: 900;
      background: var(--accent);
      border-radius: 12px 12px 12px 3px;
      box-shadow: 0 0 0 1px #ffffff18 inset, 0 12px 36px #75e8ad20;
    }
    .brand h1 { margin: 0; font-size: clamp(1.1rem, 2vw, 1.38rem); letter-spacing: -.025em; }
    .brand p { margin: 3px 0 0; color: var(--muted); font-size: .82rem; }
    .local-pill {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 12px;
      color: var(--muted);
      font-size: .72rem;
      font-weight: 750;
      letter-spacing: .1em;
      text-transform: uppercase;
      background: #0e1111cc;
      border: 1px solid var(--line);
      border-radius: 999px;
    }
    .local-pill::before { width: 7px; height: 7px; content: ""; background: var(--verified); border-radius: 50%; box-shadow: 0 0 14px var(--verified); }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .stat {
      min-height: 106px;
      padding: 18px;
      background: linear-gradient(145deg, #171b1ae8, #101312e8);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: 0 12px 30px #00000024;
    }
    .stat-label { margin: 0 0 9px; color: var(--muted); font-size: .7rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
    .stat-value { margin: 0; font-size: clamp(1.55rem, 4vw, 2.1rem); font-weight: 720; letter-spacing: -.045em; }
    .stat-note { margin: 5px 0 0; color: var(--dim); font-size: .72rem; }
    .workspace {
      display: grid;
      grid-template-columns: minmax(300px, .75fr) minmax(520px, 1.55fr);
      min-height: 670px;
      overflow: hidden;
      background: #0d1010d9;
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 24px 80px #00000055;
      backdrop-filter: blur(18px);
    }
    .rail { min-width: 0; border-right: 1px solid var(--line); }
    .rail-tools { padding: 18px; border-bottom: 1px solid var(--line); }
    .search-wrap { position: relative; }
    .search-wrap::before { position: absolute; top: 11px; left: 13px; color: var(--dim); content: "⌕"; font-size: 1.1rem; }
    .search {
      width: 100%;
      height: 42px;
      padding: 0 13px 0 38px;
      color: var(--ink);
      background: #080a0a;
      border: 1px solid var(--line);
      border-radius: 11px;
      outline: none;
    }
    .search::placeholder { color: #656965; }
    .search:focus { border-color: #82d9ae88; box-shadow: 0 0 0 3px #72dca614; }
    .filters { display: flex; gap: 5px; margin-top: 11px; overflow: auto; scrollbar-width: none; }
    .filter {
      padding: 7px 10px;
      color: var(--muted);
      font-size: .71rem;
      font-weight: 720;
      white-space: nowrap;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      cursor: pointer;
    }
    .filter:hover { color: var(--ink); }
    .filter[aria-pressed="true"] { color: var(--ink); background: var(--raised); border-color: var(--line); }
    .integrity-alert {
      margin: 12px 18px 0;
      padding: 10px 12px;
      color: var(--inconclusive);
      font-size: .74rem;
      line-height: 1.4;
      background: var(--inconclusive-soft);
      border: 1px solid #8d713b66;
      border-radius: 9px;
    }
    .hidden { display: none !important; }
    .run-list { max-height: 610px; overflow: auto; padding: 8px; }
    .run-item {
      display: block;
      width: 100%;
      padding: 14px 13px;
      color: inherit;
      text-align: left;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 12px;
      cursor: pointer;
    }
    .run-item + .run-item { margin-top: 3px; }
    .run-item:hover { background: #ffffff05; }
    .run-item[aria-current="true"] { background: linear-gradient(135deg, #1a211e, #151918); border-color: var(--line-bright); box-shadow: 0 8px 26px #0000002b; }
    .run-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .repo { overflow: hidden; font-size: .77rem; font-weight: 720; text-overflow: ellipsis; white-space: nowrap; }
    .subject { margin: 8px 0 10px; overflow: hidden; color: #dadad3; font-size: .87rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
    .run-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .66rem; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 7px;
      font-size: .62rem;
      font-weight: 820;
      letter-spacing: .075em;
      text-transform: uppercase;
      border-radius: 999px;
    }
    .badge::before { width: 5px; height: 5px; content: ""; background: currentColor; border-radius: 50%; }
    .badge.verified { color: var(--verified); background: var(--verified-soft); }
    .badge.rejected { color: var(--rejected); background: var(--rejected-soft); }
    .badge.inconclusive { color: var(--inconclusive); background: var(--inconclusive-soft); }
    .detail { min-width: 0; padding: clamp(20px, 3vw, 34px); overflow: auto; }
    .detail-empty { display: grid; min-height: 560px; place-items: center; color: var(--muted); text-align: center; }
    .detail-empty strong { display: block; margin-bottom: 6px; color: var(--ink); font-size: 1.05rem; }
    .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
    .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: .68rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
    .detail h2 { max-width: 770px; margin: 0; font-size: clamp(1.35rem, 3vw, 2.15rem); line-height: 1.12; letter-spacing: -.045em; }
    .reason-list { display: flex; flex-wrap: wrap; gap: 7px; margin: 13px 0 0; padding: 0; list-style: none; }
    .reason-list li { padding: 5px 8px; color: #b8bbb6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .66rem; background: #ffffff08; border: 1px solid var(--line); border-radius: 6px; }
    .section { margin-top: 26px; }
    .section-title { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; font-size: .76rem; font-weight: 790; letter-spacing: .1em; text-transform: uppercase; }
    .section-title::after { height: 1px; flex: 1; content: ""; background: var(--line); }
    .identity-grid, .mini-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
    .fact { min-width: 0; padding: 13px; background: #ffffff04; border: 1px solid var(--line); border-radius: 10px; }
    .fact-label { margin: 0 0 7px; color: var(--dim); font-size: .64rem; font-weight: 730; letter-spacing: .08em; text-transform: uppercase; }
    .fact-value { margin: 0; overflow-wrap: anywhere; color: #dddcd5; font-size: .81rem; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .7rem; }
    .attempts-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 11px; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; }
    th { padding: 10px 12px; color: var(--dim); font-size: .61rem; font-weight: 780; letter-spacing: .08em; text-align: left; text-transform: uppercase; background: #0b0d0d; }
    td { padding: 12px; color: #cfd0ca; font-size: .75rem; border-top: 1px solid var(--line); vertical-align: top; }
    .lane { color: var(--ink); font-weight: 760; text-transform: capitalize; }
    .outcome { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .68rem; }
    .artifact-links { display: flex; flex-wrap: wrap; gap: 5px; }
    .artifact-link, .file-link {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--accent);
      font-size: .67rem;
      text-decoration: none;
      border-bottom: 1px solid #8be3b755;
    }
    .artifact-link:hover, .file-link:hover { color: white; border-color: white; }
    .file-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .file-card { min-width: 0; padding: 12px; background: #ffffff04; border: 1px solid var(--line); border-radius: 9px; }
    .file-card .file-link { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-meta { margin-top: 5px; color: var(--dim); font-size: .62rem; }
    .cleanup-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .cleanup-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: #ffffff04; border: 1px solid var(--line); border-radius: 9px; font-size: .73rem; }
    .cleanup-state { color: var(--verified); font-weight: 750; }
    .cleanup-state.failed { color: var(--rejected); }
    .loading { animation: pulse 1.15s ease-in-out infinite alternate; }
    .error-box { padding: 16px; color: var(--rejected); background: var(--rejected-soft); border: 1px solid #9c504966; border-radius: 10px; }
    .empty-list { padding: 45px 18px; color: var(--muted); font-size: .8rem; line-height: 1.5; text-align: center; }
    .footer { display: flex; justify-content: space-between; gap: 16px; margin: 18px 2px 0; color: var(--dim); font-size: .66rem; }
    :focus-visible { outline: 2px solid var(--verified); outline-offset: 2px; }
    @keyframes pulse { from { opacity: .45; } to { opacity: .9; } }
    @media (max-width: 940px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workspace { grid-template-columns: 1fr; }
      .rail { border-right: 0; border-bottom: 1px solid var(--line); }
      .run-list { max-height: 370px; }
      .detail { min-height: 600px; }
    }
    @media (max-width: 620px) {
      .shell { padding: 16px; }
      .masthead { align-items: flex-start; }
      .brand p { display: none; }
      .local-pill { padding: 8px; font-size: 0; }
      .stats { gap: 8px; }
      .stat { min-height: 88px; padding: 14px; }
      .workspace { border-radius: 16px; }
      .detail-header { flex-direction: column-reverse; gap: 12px; }
      .identity-grid, .mini-grid, .file-grid { grid-template-columns: 1fr; }
      .footer { flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#proof-detail">Skip to proof detail</a>
  <main class="shell">
    <header class="masthead">
      <div class="brand">
        <div class="mark" aria-hidden="true">A</div>
        <div>
          <h1>Antibody Proof Ledger</h1>
          <p>Integrity-checked causal evidence · local and read-only</p>
        </div>
      </div>
      <div class="local-pill">Local session</div>
    </header>

    <section class="stats" aria-label="Proof summary">
      <article class="stat"><p class="stat-label">Proof runs</p><p class="stat-value" id="stat-total">—</p><p class="stat-note">verified receipts only</p></article>
      <article class="stat"><p class="stat-label">Verified</p><p class="stat-value" id="stat-verified">—</p><p class="stat-note">causal gate passed</p></article>
      <article class="stat"><p class="stat-label">Needs review</p><p class="stat-value" id="stat-review">—</p><p class="stat-note">rejected + inconclusive</p></article>
      <article class="stat"><p class="stat-label">Recorded spend</p><p class="stat-value" id="stat-cost">—</p><p class="stat-note">available cost fields</p></article>
    </section>

    <section class="workspace" aria-label="Proof explorer">
      <aside class="rail" aria-label="Proof runs">
        <div class="rail-tools">
          <label class="search-wrap">
            <span class="hidden">Search proof runs</span>
            <input class="search" id="search" type="search" placeholder="Search repo, subject, hash…" autocomplete="off">
          </label>
          <div class="filters" id="filters" aria-label="Filter by verdict">
            <button class="filter" type="button" data-filter="all" aria-pressed="true">All</button>
            <button class="filter" type="button" data-filter="verified" aria-pressed="false">Verified</button>
            <button class="filter" type="button" data-filter="inconclusive" aria-pressed="false">Inconclusive</button>
            <button class="filter" type="button" data-filter="rejected" aria-pressed="false">Rejected</button>
          </div>
        </div>
        <div class="integrity-alert hidden" id="integrity-alert" role="status"></div>
        <div class="run-list" id="run-list" aria-live="polite"><div class="empty-list loading">Verifying local proof receipts…</div></div>
      </aside>

      <article class="detail" id="proof-detail" aria-live="polite">
        <div class="detail-empty"><div><strong>Select a proof run</strong>Inspect causal evidence, hashes, artifacts, costs, and cleanup.</div></div>
      </article>
    </section>

    <footer class="footer">
      <span>Nothing here can mutate a proof run.</span>
      <span>Receipt hashes detect mutation; they are not signatures.</span>
    </footer>
  </main>
  <noscript><p>This dashboard needs local JavaScript to load receipt data. No code or assets are fetched from the internet.</p></noscript>
  <script nonce="${nonce}">
    'use strict';

    const state = {runs: [], selectedId: null, filter: 'all', query: ''};
    const runList = document.getElementById('run-list');
    const detail = document.getElementById('proof-detail');
    const search = document.getElementById('search');
    const filters = document.getElementById('filters');
    const integrityAlert = document.getElementById('integrity-alert');

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }

    function badge(verdict) {
      return el('span', 'badge ' + verdict, verdict);
    }

    function shortHash(value, length = 12) {
      const clean = String(value).replace(/^sha256:/, '');
      return clean.slice(0, length);
    }

    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.valueOf())) return String(value);
      return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(date);
    }

    function formatDuration(milliseconds) {
      if (milliseconds < 1000) return milliseconds + ' ms';
      if (milliseconds < 60000) return (milliseconds / 1000).toFixed(1) + ' s';
      return (milliseconds / 60000).toFixed(1) + ' min';
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      return (bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
    }

    function setStats() {
      const verified = state.runs.filter((run) => run.verdict === 'verified').length;
      const totalCost = state.runs.reduce((sum, run) => sum + (run.totalCostUsd || 0), 0);
      document.getElementById('stat-total').textContent = String(state.runs.length);
      document.getElementById('stat-verified').textContent = String(verified);
      document.getElementById('stat-review').textContent = String(state.runs.length - verified);
      document.getElementById('stat-cost').textContent = totalCost ? '$' + totalCost.toFixed(2) : '—';
    }

    function visibleRuns() {
      const query = state.query.trim().toLowerCase();
      return state.runs.filter((run) => {
        if (state.filter !== 'all' && run.verdict !== state.filter) return false;
        if (!query) return true;
        return [run.repository, run.subject, run.runId, run.candidateId, run.fixSha, run.patchSha256]
          .some((value) => String(value).toLowerCase().includes(query));
      });
    }

    function renderRunList() {
      runList.replaceChildren();
      const runs = visibleRuns();
      if (!runs.length) {
        runList.append(el('div', 'empty-list', state.runs.length ? 'No proof runs match this filter.' : 'No valid proof runs found.'));
        return;
      }
      for (const run of runs) {
        const button = el('button', 'run-item');
        button.type = 'button';
        button.setAttribute('aria-current', String(run.runId === state.selectedId));
        button.addEventListener('click', () => selectRun(run.runId));
        const top = el('div', 'run-top');
        top.append(el('span', 'repo', run.repository), badge(run.verdict));
        const subject = el('p', 'subject', run.subject);
        const meta = el('div', 'run-meta');
        meta.append(el('span', '', formatDate(run.createdAt)), el('span', '', shortHash(run.fixSha, 8)));
        button.append(top, subject, meta);
        runList.append(button);
      }
    }

    function fact(label, value, mono = false) {
      const wrapper = el('div', 'fact');
      wrapper.append(el('p', 'fact-label', label), el('p', 'fact-value' + (mono ? ' mono' : ''), value));
      return wrapper;
    }

    function section(title) {
      const wrapper = el('section', 'section');
      wrapper.append(el('h3', 'section-title', title));
      return wrapper;
    }

    function safeFileLink(file, className = 'file-link') {
      const link = el('a', className, file.label || file.name);
      if (typeof file.url === 'string' && file.url.startsWith('/api/runs/')) {
        link.href = file.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      return link;
    }

    function renderAttempts(run) {
      const wrapper = section('Evidence attempt matrix');
      if (!run.attempts.length) {
        wrapper.append(el('div', 'empty-list', 'No execution attempts recorded.'));
        return wrapper;
      }
      const scroll = el('div', 'attempts-wrap');
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const header = document.createElement('tr');
      for (const label of ['Lane', 'Phase', 'Run', 'Outcome', 'Duration', 'Exit', 'Artifacts']) header.append(el('th', '', label));
      thead.append(header);
      const tbody = document.createElement('tbody');
      for (const attempt of run.attempts) {
        const row = document.createElement('tr');
        row.append(el('td', 'lane', attempt.lane));
        row.append(el('td', '', attempt.phase));
        row.append(el('td', 'mono', '#' + String(attempt.attempt + 1)));
        const outcome = el('td', 'outcome', attempt.outcome || attempt.termination);
        if (attempt.explanation) outcome.title = attempt.explanation;
        row.append(outcome);
        row.append(el('td', 'mono', formatDuration(attempt.durationMs)));
        row.append(el('td', 'mono', attempt.exitCode === null ? '—' : attempt.exitCode));
        const artifactCell = el('td');
        const links = el('div', 'artifact-links');
        for (const artifact of attempt.artifacts) links.append(safeFileLink(artifact, 'artifact-link'));
        artifactCell.append(links);
        row.append(artifactCell);
        tbody.append(row);
      }
      table.append(thead, tbody);
      scroll.append(table);
      wrapper.append(scroll);
      return wrapper;
    }

    function renderFiles(run) {
      const wrapper = section('Raw local artifacts');
      const grid = el('div', 'file-grid');
      for (const file of run.files) {
        const card = el('div', 'file-card');
        card.append(safeFileLink(file), el('div', 'file-meta', file.mediaType + (file.sizeBytes ? ' · ' + formatBytes(file.sizeBytes) : '')));
        grid.append(card);
      }
      wrapper.append(grid);
      return wrapper;
    }

    function renderCleanup(run) {
      const wrapper = section('Cleanup');
      const list = el('ul', 'cleanup-list');
      if (!run.cleanup.length) list.append(el('li', 'empty-list', 'No cleanup records.'));
      for (const item of run.cleanup) {
        const row = el('li', 'cleanup-row');
        row.append(el('span', 'mono', item.devboxId));
        const complete = item.requested && item.completed;
        row.append(el('span', 'cleanup-state' + (complete ? '' : ' failed'), complete ? 'Completed' : (item.errorCode || 'Incomplete')));
        list.append(row);
      }
      wrapper.append(list);
      return wrapper;
    }

    function renderDetail(run) {
      detail.replaceChildren();
      const header = el('header', 'detail-header');
      const title = el('div');
      title.append(el('p', 'eyebrow', run.repository + ' · ' + formatDate(run.createdAt)), el('h2', '', run.subject));
      const reasons = el('ul', 'reason-list');
      for (const reason of run.reasonCodes) reasons.append(el('li', '', reason));
      title.append(reasons);
      header.append(title, badge(run.verdict));

      const identity = section('Proof identity');
      const identityGrid = el('div', 'identity-grid');
      identityGrid.append(
        fact('Candidate SHA-256', run.candidateId, true),
        fact('Patch SHA-256', run.patchSha256, true),
        fact('Fix commit', run.fixSha, true),
        fact('Parent commit', run.parentSha, true),
        fact('Current head', run.headSha, true),
        fact('Receipt SHA-256', run.receiptSha256, true),
      );
      identity.append(identityGrid);

      const proof = section('Policy and environment');
      const proofGrid = el('div', 'mini-grid');
      const cost = (run.costs.modelUsd || 0) + (run.costs.runloopUsd || 0);
      proofGrid.append(
        fact('Test-only policy', run.policy.testOnly ? 'Passed' : 'Failed'),
        fact('Environment equivalent', run.environment.equivalent ? 'Yes' : 'No'),
        fact('Changed paths', run.patch.changedPaths.join(', ')),
        fact('Recorded cost', cost ? '$' + cost.toFixed(4) : 'Not recorded'),
      );
      proof.append(proofGrid);

      detail.append(header, identity, proof, renderAttempts(run), renderCleanup(run), renderFiles(run));
    }

    async function selectRun(runId) {
      state.selectedId = runId;
      renderRunList();
      detail.replaceChildren(el('div', 'detail-empty loading', 'Verifying receipt and loading evidence…'));
      try {
        const response = await fetch('/api/runs/' + encodeURIComponent(runId), {headers: {'Accept': 'application/json'}});
        if (!response.ok) throw new Error('Proof detail request failed');
        const payload = await response.json();
        if (!payload || !payload.run || payload.run.runId !== state.selectedId) return;
        renderDetail(payload.run);
        const url = new URL(window.location.href);
        url.searchParams.set('run', runId);
        history.replaceState(null, '', url);
      } catch {
        detail.replaceChildren(el('div', 'error-box', 'Could not load this proof. Its integrity may have changed since the list was read.'));
      }
    }

    search.addEventListener('input', () => {
      state.query = search.value;
      renderRunList();
    });

    filters.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-filter]');
      if (!button) return;
      state.filter = button.dataset.filter;
      for (const candidate of filters.querySelectorAll('button[data-filter]')) {
        candidate.setAttribute('aria-pressed', String(candidate === button));
      }
      renderRunList();
    });

    async function boot() {
      try {
        const response = await fetch('/api/runs', {headers: {'Accept': 'application/json'}});
        if (!response.ok) throw new Error('Proof index request failed');
        const payload = await response.json();
        state.runs = Array.isArray(payload.runs) ? payload.runs : [];
        setStats();
        if (payload.invalidRunCount > 0) {
          integrityAlert.textContent = String(payload.invalidRunCount) + ' invalid or tampered run' + (payload.invalidRunCount === 1 ? ' was' : 's were') + ' excluded.';
          integrityAlert.classList.remove('hidden');
        }
        const requestedId = new URL(window.location.href).searchParams.get('run');
        const selected = state.runs.find((run) => run.runId === requestedId) || state.runs[0];
        renderRunList();
        if (selected) await selectRun(selected.runId);
      } catch {
        runList.replaceChildren(el('div', 'error-box', 'Could not read the local proof directory.'));
        detail.replaceChildren(el('div', 'detail-empty', 'Dashboard data is unavailable.'));
      }
    }

    void boot();
  </script>
</body>
</html>
`;
}
