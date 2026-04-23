// catalog/app.js
// Vanilla browser JS. No bundler, no framework. ES module.
// Fetches registry.json and renders a flow card per entry.

/**
 * Active tag filter. Empty string means "show all".
 * @type {string}
 */
let _activeTag = '';

/**
 * All flows loaded from registry.json.
 * @type {Array<Object>}
 */
let allFlows = [];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', main);

async function main() {
  const res = await fetchRegistry();
  if (!res.ok) {
    showError(res.error);
    return;
  }

  allFlows = res.flows;
  buildTagFilter(allFlows);
  renderFlows(allFlows);
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchRegistry() {
  const loadingEl = document.getElementById('flows-loading');

  let response;
  try {
    response = await fetch('./registry.json');
  } catch (_networkErr) {
    return { ok: false, error: 'Could not reach registry.json. Check network or local server.' };
  }

  if (!response.ok) {
    return { ok: false, error: 'Failed to load catalog (HTTP ' + response.status + ').' };
  }

  let doc;
  try {
    doc = await response.json();
  } catch {
    return { ok: false, error: 'registry.json is not valid JSON.' };
  }

  if (!Array.isArray(doc.flows)) {
    return { ok: false, error: 'registry.json missing "flows" array.' };
  }

  if (loadingEl) loadingEl.hidden = true;

  return { ok: true, flows: doc.flows };
}

// ---------------------------------------------------------------------------
// Tag filter UI
// ---------------------------------------------------------------------------

function buildTagFilter(flows) {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;

  // Collect unique tags across all flows, preserving insertion order.
  const seen = new Set();
  for (const flow of flows) {
    if (Array.isArray(flow.tags)) {
      for (const tag of flow.tags) {
        seen.add(tag);
      }
    }
  }

  if (seen.size === 0) return;

  // "All" button
  const allBtn = makeTagButton('all', true);
  allBtn.addEventListener('click', () => {
    _activeTag = '';
    updateTagButtons(bar, '');
    renderFlows(allFlows);
  });
  bar.appendChild(allBtn);

  // One button per tag
  for (const tag of seen) {
    const btn = makeTagButton(tag, false);
    btn.addEventListener('click', () => {
      _activeTag = tag;
      updateTagButtons(bar, tag);
      renderFlows(allFlows.filter((f) => Array.isArray(f.tags) && f.tags.includes(tag)));
    });
    bar.appendChild(btn);
  }
}

function makeTagButton(label, isActive) {
  const btn = document.createElement('button');
  btn.className = 'tag-btn';
  btn.textContent = label;
  btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  return btn;
}

function updateTagButtons(bar, activeTagValue) {
  const buttons = bar.querySelectorAll('.tag-btn');
  for (const btn of buttons) {
    const isAll = btn.textContent === 'all';
    const isActive = isAll ? activeTagValue === '' : btn.textContent === activeTagValue;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }
}

// ---------------------------------------------------------------------------
// Flow rendering
// ---------------------------------------------------------------------------

function renderFlows(flows) {
  const container = document.getElementById('flows');
  if (!container) return;
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  if (flows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'flows-loading';
    empty.textContent = 'No flows match this filter.';
    container.appendChild(empty);
    return;
  }

  for (const flow of flows) {
    container.appendChild(renderFlowCard(flow));
  }
}

function renderFlowCard(flow) {
  const card = document.createElement('article');
  card.className = 'flow-card';

  // ── header: displayName + version ────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'flow-card-header';

  const displayName = document.createElement('span');
  displayName.className = 'flow-display-name';
  displayName.textContent = flow.displayName || flow.name;
  header.appendChild(displayName);

  const version = document.createElement('span');
  version.className = 'flow-version';
  version.textContent = 'v' + (flow.version || '0.0.0');
  header.appendChild(version);

  card.appendChild(header);

  // ── tags ─────────────────────────────────────────────────────────────────
  if (Array.isArray(flow.tags) && flow.tags.length > 0) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'flow-tags';
    for (const tag of flow.tags) {
      const t = document.createElement('span');
      t.className = 'flow-tag';
      t.textContent = tag;
      tagsEl.appendChild(t);
    }
    card.appendChild(tagsEl);
  }

  // ── metadata rows ─────────────────────────────────────────────────────────
  const meta = document.createElement('div');
  meta.className = 'flow-meta';

  meta.appendChild(makeMetaRow('cost', formatCostRange(flow.estimatedCostUsd)));
  meta.appendChild(makeMetaRow('duration', formatDurationRange(flow.estimatedDurationMin)));

  if (Array.isArray(flow.audience) && flow.audience.length > 0) {
    meta.appendChild(makeMetaRow('audience', flow.audience.join(', ')));
  }

  card.appendChild(meta);

  // ── readme excerpt ────────────────────────────────────────────────────────
  if (flow.readmeExcerpt) {
    const excerpt = document.createElement('p');
    excerpt.className = 'flow-excerpt';
    // Truncate to 200 chars for the card view
    const text =
      flow.readmeExcerpt.length > 200 ? flow.readmeExcerpt.slice(0, 200) + '…' : flow.readmeExcerpt;
    excerpt.textContent = text;
    card.appendChild(excerpt);
  }

  // ── install command ───────────────────────────────────────────────────────
  const install = document.createElement('div');
  install.className = 'flow-install';
  const npmPkg = flow.npmPackage || flow.name;
  install.textContent = 'relay install ' + npmPkg;
  card.appendChild(install);

  // ── footer: repo link ─────────────────────────────────────────────────────
  const footer = document.createElement('div');
  footer.className = 'flow-card-footer';

  if (flow.repoUrl) {
    const link = document.createElement('a');
    link.className = 'flow-readme-link';
    link.href = flow.repoUrl;
    link.rel = 'noopener noreferrer';
    link.target = '_blank';
    link.textContent = 'source →';
    footer.appendChild(link);
  } else {
    // Empty placeholder to preserve layout
    footer.appendChild(document.createElement('span'));
  }

  card.appendChild(footer);

  return card;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetaRow(label, value) {
  const row = document.createElement('div');
  row.className = 'flow-meta-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'flow-meta-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'flow-meta-value';
  valueEl.textContent = value;

  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

function formatCostRange(range) {
  if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') {
    return 'unknown';
  }
  return '$' + range.min.toFixed(2) + ' – $' + range.max.toFixed(2);
}

function formatDurationRange(range) {
  if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') {
    return 'unknown';
  }
  return range.min + ' – ' + range.max + ' min';
}

function showError(message) {
  const loadingEl = document.getElementById('flows-loading');
  const errorEl = document.getElementById('flows-error');

  if (loadingEl) loadingEl.hidden = true;
  if (errorEl) {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }
}
