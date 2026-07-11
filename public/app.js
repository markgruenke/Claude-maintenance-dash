'use strict';
/* Dashboard frontend: fetches /api/dashboard and renders everything.
   Charts are hand-built SVG following the house dataviz spec: thin marks,
   4px rounded data-ends, hairline solid grid, hover tooltips, and a table
   twin behind every chart. */

const $ = (sel) => document.querySelector(sel);

const state = {
  rangeDays: 30,       // '' = all time
  machineId: '',
  technician: '',
  data: null,
};

// ------------------------------------------------------------- utilities

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtHours(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${h % 1 === 0 ? h : h.toFixed(1)} h`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function daysAgo(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ------------------------------------------------------------------ data

function rangeParams() {
  const p = new URLSearchParams();
  if (state.rangeDays) {
    const from = new Date(Date.now() - state.rangeDays * 86400000);
    p.set('from', from.toISOString().slice(0, 10));
  }
  if (state.machineId) p.set('machineId', state.machineId);
  if (state.technician) p.set('technician', state.technician);
  return p.toString();
}

async function refresh() {
  // Refetch keeps the frame: dim, don't blank.
  document.querySelectorAll('.card').forEach((c) => c.classList.add('refetching'));
  try {
    state.data = await api('/api/dashboard?' + rangeParams());
    renderAll();
  } catch (err) {
    toast('Failed to load: ' + err.message);
  } finally {
    document.querySelectorAll('.card').forEach((c) => c.classList.remove('refetching'));
  }
}

// ---------------------------------------------------------------- render

function renderAll() {
  const d = state.data;
  renderFilters(d);
  renderKpis(d);
  renderFlags(d);
  renderHoursChart(d);
  renderBreakdownChart(d);
  renderTrendChart(d);
  renderOrdersTable(d);
  renderPartsTable(d);
  renderLogsTable(d);
  $('#sub-line').textContent = state.rangeDays ? `last ${state.rangeDays} days` : 'all time';

  const dl = $('#machine-list');
  dl.replaceChildren(...d.machines.map((m) => el('option', { value: m.name })));
}

function renderFilters(d) {
  const mSel = $('#f-machine');
  const current = mSel.value;
  mSel.replaceChildren(el('option', { value: '' }, 'All machines'),
    ...d.machines.map((m) => el('option', { value: m.id }, m.name)));
  mSel.value = state.machineId || current || '';

  const techs = [...new Set(d.workLogs.map((l) => l.technician).concat(d.technicians.map((t) => t.name)))].filter(Boolean);
  const tSel = $('#f-tech');
  tSel.replaceChildren(el('option', { value: '' }, 'Everyone'),
    ...techs.map((t) => el('option', { value: t }, t)));
  tSel.value = state.technician || '';
}

function renderKpis(d) {
  const s = d.summary;
  const tiles = [
    { label: 'Open work orders', value: s.openOrders,
      hint: s.waitingParts ? `${s.waitingParts} waiting on parts` : 'none waiting on parts' },
    { label: 'Time logged', value: fmtHours(s.minutesLogged), hint: state.rangeDays ? `last ${state.rangeDays} days` : 'all time' },
    { label: 'Parts to chase', value: s.partsNeeded, hint: 'needed or on order' },
    { label: 'Attention flags', value: s.flagCount,
      hint: s.flagCount ? `${s.flaggedMachines} machine${s.flaggedMachines === 1 ? '' : 's'} affected` : 'all clear', good: !s.flagCount },
  ];
  $('#kpis').replaceChildren(...tiles.map((t) => el('div', { class: 'tile' }, [
    el('div', { class: 'label' }, t.label),
    el('div', { class: 'value' }, String(t.value)),
    el('div', { class: 'hint' + (t.good ? ' good' : '') }, t.hint),
  ])));
}

const SEV_LABEL = { warning: '⚠ Warning', serious: '▲ Serious', critical: '● Critical' };

function renderFlags(d) {
  const box = $('#flags');
  box.replaceChildren(...d.flags.map((f) => el('div', { class: 'flag ' + f.severity }, [
    el('span', { class: 'dot' }),
    el('span', { class: 'sev' }, SEV_LABEL[f.severity] || f.severity),
    el('span', { class: 'msg' }, f.message),
  ])));
}

// ---------------------------------------------------------------- charts

const tooltipBox = (() => {
  const t = el('div', { class: 'tooltip' });
  document.body.append(t);
  return t;
})();

function showTooltip(anchorRect, title, rows) {
  tooltipBox.replaceChildren(
    el('div', { class: 't-title' }, title),
    ...rows.map((r) => el('div', { class: 't-row' }, [
      el('span', { class: 't-key' }),
      el('span', { class: 't-val' }, r.value),
      el('span', { class: 't-name' }, r.name || ''),
    ])),
  );
  tooltipBox.style.display = 'block';
  const tw = tooltipBox.offsetWidth, th = tooltipBox.offsetHeight;
  let x = anchorRect.x + anchorRect.width / 2 - tw / 2 + window.scrollX;
  let y = anchorRect.y - th - 8 + window.scrollY;
  x = Math.max(8, Math.min(x, window.scrollX + document.documentElement.clientWidth - tw - 8));
  if (y < window.scrollY + 4) y = anchorRect.y + anchorRect.height + 8 + window.scrollY;
  tooltipBox.style.left = x + 'px';
  tooltipBox.style.top = y + 'px';
}

function hideTooltip() { tooltipBox.style.display = 'none'; }

/** Horizontal bar path: square at the baseline (left), 4px rounded data end. */
function hBarPath(x, y, w, h) {
  const r = Math.min(4, w);
  return `M${x},${y} h${w - r} q${r},0 ${r},${r} v${h - 2 * r} q0,${r} -${r},${r} h${-(w - r)} z`;
}

/**
 * Horizontal bar chart, one series (slot 1). Machine name left, value at tip.
 */
function renderHBarChart(container, rows, { fmt = String } = {}) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(el('div', { class: 'empty' }, 'No data in this range yet'));
    return;
  }
  const W = 600, labelW = 150, rowH = 32, barH = 18, padTop = 4;
  const H = padTop + rows.length * rowH + 4;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const plotW = W - labelW - 60; // leave room for tip labels

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  // hairline baseline at x = labelW
  svg.append(svgEl('line', {
    x1: labelW, y1: 0, x2: labelW, y2: H,
    stroke: 'var(--baseline)', 'stroke-width': 1,
  }));

  rows.forEach((r, i) => {
    const y = padTop + i * rowH + (rowH - barH) / 2;
    const w = Math.max((r.value / max) * plotW, 2);

    const name = svgEl('text', {
      x: labelW - 8, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'dlabel',
    }, r.label.length > 20 ? r.label.slice(0, 19) + '…' : r.label);

    const bar = svgEl('path', { d: hBarPath(labelW, y, w, barH), fill: 'var(--series-1)' });
    const tip = svgEl('text', {
      x: labelW + w + 6, y: y + barH / 2 + 4, class: 'dlabel',
    }, fmt(r.value));

    // Hit target: the whole row band, wider than the mark.
    const hit = svgEl('rect', { x: 0, y: padTop + i * rowH, width: W, height: rowH, class: 'bar-hit', tabindex: 0 });
    const show = () => {
      bar.setAttribute('opacity', '0.82');
      showTooltip(hit.getBoundingClientRect(), r.label, [{ value: fmt(r.value), name: r.sub || '' }]);
    };
    const hide = () => { bar.removeAttribute('opacity'); hideTooltip(); };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);

    svg.append(bar, name, tip, hit);
  });

  container.append(svg);
}

/** Weekly trend line: 2px line, 10% area wash, end dot with surface ring,
 *  crosshair + tooltip snapping to the nearest week. */
function renderLineChart(container, points, { fmt = String } = {}) {
  container.replaceChildren();
  if (points.length === 0) {
    container.append(el('div', { class: 'empty' }, 'No data in this range yet'));
    return;
  }
  const W = 600, H = 200, padL = 34, padR = 20, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...points.map((p) => p.count), 1);
  // Clean y ticks: 0, half, max rounded up.
  const yMax = Math.max(Math.ceil(max / 2) * 2, 2);
  const xAt = (i) => points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
  const yAt = (v) => padT + plotH - (v / yMax) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  // gridlines: solid hairlines at 0, mid, max
  for (const v of [0, yMax / 2, yMax]) {
    svg.append(svgEl('line', {
      x1: padL, y1: yAt(v), x2: W - padR, y2: yAt(v),
      stroke: v === 0 ? 'var(--baseline)' : 'var(--grid)', 'stroke-width': 1,
    }));
    svg.append(svgEl('text', { x: padL - 6, y: yAt(v) + 4, 'text-anchor': 'end', class: 'tick' }, String(v)));
  }

  // x labels: first, middle, last week
  const labelIdx = points.length <= 3 ? points.map((_, i) => i)
    : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  for (const i of labelIdx) {
    svg.append(svgEl('text', { x: xAt(i), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, fmtDate(points[i].weekStart)));
  }

  const lineD = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(p.count).toFixed(1)}`).join('');
  if (points.length > 1) {
    svg.append(svgEl('path', {
      d: lineD + `L${xAt(points.length - 1)},${yAt(0)}L${xAt(0)},${yAt(0)}Z`,
      fill: 'var(--series-1)', opacity: 0.1,
    }));
    svg.append(svgEl('path', {
      d: lineD, fill: 'none', stroke: 'var(--series-1)',
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  // end dot: >=8px with a 2px surface ring
  const last = points.length - 1;
  svg.append(svgEl('circle', {
    cx: xAt(last), cy: yAt(points[last].count), r: 4.5,
    fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2,
  }));
  // endpoint direct label (selective — just the latest value)
  svg.append(svgEl('text', {
    x: xAt(last), y: yAt(points[last].count) - 9, 'text-anchor': 'middle', class: 'dlabel',
  }, fmt(points[last].count)));

  // crosshair + hover layer
  const cross = svgEl('line', {
    y1: padT, y2: padT + plotH, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden',
  });
  const hoverDot = svgEl('circle', {
    r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden',
  });
  const overlay = svgEl('rect', { x: padL, y: 0, width: plotW, height: H, fill: 'transparent' });
  overlay.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    let best = 0, bestDist = Infinity;
    points.forEach((_, i) => {
      const d2 = Math.abs(xAt(i) - px);
      if (d2 < bestDist) { bestDist = d2; best = i; }
    });
    const cx = xAt(best), cy = yAt(points[best].count);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', cx); hoverDot.setAttribute('cy', cy);
    hoverDot.setAttribute('visibility', 'visible');
    const sx = rect.left + (cx / W) * rect.width;
    const sy = rect.top + (cy / H) * rect.height;
    showTooltip({ x: sx - 12, y: sy - 12, width: 24, height: 24 },
      'Week of ' + fmtDate(points[best].weekStart),
      [{ value: String(points[best].count), name: points[best].count === 1 ? 'order' : 'orders' }]);
  });
  overlay.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    hideTooltip();
  });

  svg.append(cross, hoverDot, overlay);
  container.append(svg);
}

function chartTable(container, headers, rows) {
  container.replaceChildren(el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { class: i ? 'num' : '' }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: i ? 'num' : '' }, String(c)))))),
  ]));
}

function renderHoursChart(d) {
  const rows = d.perMachine
    .filter((m) => m.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 12)
    .map((m) => ({ label: m.machineName, value: m.minutes, sub: m.area }));
  renderHBarChart($('#chart-hours'), rows, { fmt: fmtHours });
  chartTable($('#table-hours'), ['Machine', 'Time'], rows.map((r) => [r.label, fmtHours(r.value)]));
}

function renderBreakdownChart(d) {
  const rows = d.perMachine
    .filter((m) => m.orderCount > 0)
    .sort((a, b) => b.orderCount - a.orderCount)
    .slice(0, 12)
    .map((m) => ({ label: m.machineName, value: m.orderCount, sub: `${m.openCount} open` }));
  renderHBarChart($('#chart-breakdowns'), rows, { fmt: (v) => `${v}` });
  chartTable($('#table-breakdowns'), ['Machine', 'Work orders'], rows.map((r) => [r.label, r.value]));
}

function renderTrendChart(d) {
  renderLineChart($('#chart-trend'), d.ordersOverTime);
  chartTable($('#table-trend'), ['Week of', 'Orders'],
    d.ordersOverTime.map((p) => [fmtDate(p.weekStart), p.count]));
}

// ---------------------------------------------------------------- tables

const WO_STATUSES = ['open', 'in_progress', 'waiting_parts', 'completed', 'cancelled'];
const PART_STATUSES = ['needed', 'ordered', 'received', 'installed'];

function statusBadge(status) {
  return el('span', { class: 'badge ' + status }, [
    el('span', { class: 'dot' }), status.replace('_', ' '),
  ]);
}

function machineName(d, machineId) {
  const m = d.machines.find((x) => x.id === machineId);
  return m ? m.name : '—';
}

function statusSelect(current, options, onchange) {
  const sel = el('select', { class: 'inline', onchange: (e) => onchange(e.target.value) },
    options.map((s) => el('option', { value: s }, s.replace('_', ' '))));
  sel.value = current;
  return sel;
}

function renderOrdersTable(d) {
  const open = d.workOrders
    .filter((w) => !['completed', 'cancelled'].includes(w.status))
    .sort((a, b) => ({ urgent: 0, high: 1, medium: 2, low: 3 }[a.priority] - { urgent: 0, high: 1, medium: 2, low: 3 }[b.priority])
      || b.createdAt.localeCompare(a.createdAt));
  const box = $('#orders-table');
  if (!open.length) {
    box.replaceChildren(el('div', { class: 'empty' }, 'No open work orders — nice.'));
    return;
  }
  box.replaceChildren(el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, ['Order', 'Machine', 'Issue', 'Priority', 'Opened', 'Status'].map((h) => el('th', {}, h)))),
    el('tbody', {}, open.map((w) => el('tr', {}, [
      el('td', {}, w.orderNumber ? '#' + w.orderNumber : '—'),
      el('td', {}, machineName(d, w.machineId)),
      el('td', {}, w.title),
      el('td', {}, el('span', { class: 'badge ' + w.priority }, [el('span', { class: 'dot' }), w.priority])),
      el('td', {}, daysAgo(w.createdAt)),
      el('td', {}, statusSelect(w.status, WO_STATUSES, async (v) => {
        await api('/api/work-orders/' + w.id, { method: 'PATCH', body: { status: v } });
        toast(`Order ${w.orderNumber ? '#' + w.orderNumber : ''} → ${v.replace('_', ' ')}`);
        refresh();
      })),
    ]))),
  ]));
}

function renderPartsTable(d) {
  const parts = d.parts
    .filter((p) => state.machineId ? p.machineId === state.machineId : true)
    .sort((a, b) => PART_STATUSES.indexOf(a.status) - PART_STATUSES.indexOf(b.status) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 40);
  const box = $('#parts-table');
  if (!parts.length) {
    box.replaceChildren(el('div', { class: 'empty' }, 'No parts tracked yet'));
    return;
  }
  box.replaceChildren(el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, ['Part', 'Machine', 'Qty', 'Status'].map((h, i) => el('th', { class: i === 2 ? 'num' : '' }, h)))),
    el('tbody', {}, parts.map((p) => el('tr', {}, [
      el('td', {}, p.name + (p.partNumber ? ` (${p.partNumber})` : '')),
      el('td', {}, machineName(d, p.machineId)),
      el('td', { class: 'num' }, String(p.quantity)),
      el('td', {}, statusSelect(p.status, PART_STATUSES, async (v) => {
        await api('/api/parts/' + p.id, { method: 'PATCH', body: { status: v } });
        toast(`${p.name} → ${v}`);
        refresh();
      })),
    ]))),
  ]));
}

function renderLogsTable(d) {
  const logs = [...d.workLogs].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 40);
  const box = $('#logs-table');
  if (!logs.length) {
    box.replaceChildren(el('div', { class: 'empty' }, 'No work logged in this range'));
    return;
  }
  box.replaceChildren(el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, ['Date', 'Machine', 'Tech', 'Time', 'Notes'].map((h) => el('th', {}, h)))),
    el('tbody', {}, logs.map((l) => el('tr', {}, [
      el('td', {}, fmtDate(l.date)),
      el('td', {}, machineName(d, l.machineId)),
      el('td', {}, l.technician || '—'),
      el('td', {}, l.minutes ? fmtHours(l.minutes) : '—'),
      el('td', {}, l.notes.length > 90 ? l.notes.slice(0, 89) + '…' : l.notes),
    ]))),
  ]));
}

// ----------------------------------------------------------------- wiring

$('#range-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('on', b === btn));
  state.rangeDays = btn.dataset.days ? Number(btn.dataset.days) : '';
  refresh();
});
$('#f-machine').addEventListener('change', (e) => { state.machineId = e.target.value; refresh(); });
$('#f-tech').addEventListener('change', (e) => { state.technician = e.target.value; refresh(); });

document.querySelectorAll('.btn-table').forEach((btn) => {
  btn.addEventListener('click', () => {
    const card = document.getElementById(btn.dataset.card);
    const showing = card.classList.toggle('show-table');
    btn.textContent = showing ? 'Chart' : 'Table';
  });
});

// modals
function openModal(id) { $(id).classList.add('open'); }
function closeModals() { document.querySelectorAll('.modal-back').forEach((m) => m.classList.remove('open')); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal-back').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) closeModals(); });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

// --- log work flow: preview then save
let lastPreview = null;

$('#btn-log-work').addEventListener('click', () => {
  $('#log-date').value = new Date().toISOString().slice(0, 10);
  $('#log-tech').value = localStorage.getItem('techName') || '';
  $('#log-preview').replaceChildren();
  $('#log-save-btn').disabled = true;
  lastPreview = null;
  openModal('#modal-log');
});

$('#log-preview-btn').addEventListener('click', async () => {
  const text = $('#log-text').value.trim();
  if (!text) return toast('Paste some notes first');
  try {
    lastPreview = await api('/api/ingest/notes/preview', { method: 'POST', body: { text } });
    const p = lastPreview;
    const pvRow = (key, value) => el('div', { class: 'pv-row' }, [
      el('span', { class: 'pv-key' }, key), el('span', {}, value || '—'),
    ]);
    $('#log-preview').replaceChildren(el('div', { class: 'preview' }, [
      el('h4', {}, 'What the parser found'),
      pvRow('Machine', p.machineName),
      pvRow('Order #', p.orderNumber),
      pvRow('Time spent', p.minutes != null ? fmtHours(p.minutes) : ''),
      pvRow('Parts used', p.partsUsed.join(', ')),
      pvRow('Parts needed', p.partsNeeded.join(', ')),
      pvRow('Status hint', p.statusHint ? p.statusHint.replace('_', ' ') : ''),
      el('p', { class: 'desc', style: 'margin:8px 0 0' },
        'Wrong or missing? Edit the note text and preview again — machine names it already knows are matched first.'),
    ]));
    $('#log-save-btn').disabled = false;
  } catch (err) { toast(err.message); }
});

$('#log-save-btn').addEventListener('click', async () => {
  const tech = $('#log-tech').value.trim() || 'me';
  localStorage.setItem('techName', tech);
  try {
    const out = await api('/api/ingest/notes', {
      method: 'POST',
      body: { text: $('#log-text').value.trim(), technician: tech, date: $('#log-date').value },
    });
    closeModals();
    $('#log-text').value = '';
    toast(out.createdOrder ? 'Logged — new work order created' : 'Work logged');
    refresh();
  } catch (err) { toast(err.message); }
});

// --- new order flow (manual | email paste)
$('#btn-new-order').addEventListener('click', () => openModal('#modal-order'));
$('#tab-manual').addEventListener('click', () => {
  $('#tab-manual').classList.add('on'); $('#tab-email').classList.remove('on');
  $('#order-manual').style.display = ''; $('#order-email').style.display = 'none';
});
$('#tab-email').addEventListener('click', () => {
  $('#tab-email').classList.add('on'); $('#tab-manual').classList.remove('on');
  $('#order-email').style.display = ''; $('#order-manual').style.display = 'none';
});

$('#order-save-btn').addEventListener('click', async () => {
  try {
    if ($('#tab-email').classList.contains('on')) {
      const out = await api('/api/ingest/email', {
        method: 'POST',
        body: { subject: $('#em-subject').value, body: $('#em-body').value },
      });
      toast(out.created ? `Order created${out.parsed.orderNumber ? ' #' + out.parsed.orderNumber : ''}` : 'Order already existed — matched by number');
    } else {
      const title = $('#wo-title').value.trim();
      if (!title) return toast('Give it a title');
      await api('/api/work-orders', {
        method: 'POST',
        body: {
          title,
          machineName: $('#wo-machine').value.trim(),
          orderNumber: $('#wo-number').value.trim(),
          priority: $('#wo-priority').value,
          description: $('#wo-desc').value.trim(),
          source: 'manual',
        },
      });
      toast('Work order created');
    }
    closeModals();
    ['#wo-title', '#wo-machine', '#wo-number', '#wo-desc', '#em-subject', '#em-body'].forEach((s) => { $(s).value = ''; });
    refresh();
  } catch (err) { toast(err.message); }
});

// --- add part
$('#btn-add-part').addEventListener('click', () => openModal('#modal-part'));
$('#part-save-btn').addEventListener('click', async () => {
  const name = $('#pt-name').value.trim();
  if (!name) return toast('Part needs a name');
  try {
    await api('/api/parts', {
      method: 'POST',
      body: {
        name,
        partNumber: $('#pt-number').value.trim(),
        quantity: Number($('#pt-qty').value) || 1,
        machineName: $('#pt-machine').value.trim(),
        status: $('#pt-status').value,
      },
    });
    closeModals();
    ['#pt-name', '#pt-number', '#pt-machine'].forEach((s) => { $(s).value = ''; });
    $('#pt-qty').value = '1';
    toast('Part added');
    refresh();
  } catch (err) { toast(err.message); }
});

refresh();
