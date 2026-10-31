/* Analytics dashboard: hours and work orders per machine, weekly trend,
   attention flags. Charts are hand-built SVG: thin marks, 4px rounded
   data-ends, hairline grid, hover tooltips, and a table twin per chart. */

import { mount, $, el, api, toast, fmtHours, fmtDate } from './core.js';

const dash = { rangeDays: 30, machineId: '', technician: '' };

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
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

// ------------------------------------------------------------------ view

function rangeParams() {
  const p = new URLSearchParams();
  if (dash.rangeDays) {
    const from = new Date(Date.now() - dash.rangeDays * 86400000);
    p.set('from', from.toISOString().slice(0, 10));
  }
  if (dash.machineId) p.set('machineId', dash.machineId);
  if (dash.technician) p.set('technician', dash.technician);
  return p.toString();
}

function renderKpis(d) {
  const s = d.summary;
  const tiles = [
    { label: 'Open work orders', value: s.openOrders,
      hint: s.waitingParts ? `${s.waitingParts} waiting on parts` : 'none waiting on parts' },
    { label: 'Time logged', value: fmtHours(s.minutesLogged), hint: dash.rangeDays ? `last ${dash.rangeDays} days` : 'all time' },
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

function chartCard(id, title, desc, extraStyle = '') {
  return el('div', { class: 'card', id: 'card-' + id, style: extraStyle }, [
    el('h2', {}, [title, el('span', { class: 'spacer' }), el('button', {
      class: 'ghost btn-table',
      onclick: (e) => {
        const card = e.target.closest('.card');
        const showing = card.classList.toggle('show-table');
        e.target.textContent = showing ? 'Chart' : 'Table';
      },
    }, 'Table')]),
    el('p', { class: 'desc' }, desc),
    el('div', { class: 'chart', id: 'chart-' + id }),
    el('div', { class: 'chart-table table-scroll', id: 'table-' + id }),
  ]);
}

export async function renderDashboard(root) {
  let d;
  try { d = await api('/api/dashboard?' + rangeParams()); } catch (err) { toast(err.message); return; }
  const refresh = () => renderDashboard(root);

  const ranges = [[7, '7 days'], [30, '30 days'], [90, '90 days'], ['', 'All time']];
  const mSel = el('select', { onchange: (e) => { dash.machineId = e.target.value; refresh(); } },
    [el('option', { value: '' }, 'All machines'), ...d.machines.map((m) => el('option', { value: m.id }, m.name))]);
  mSel.value = dash.machineId;
  const tSel = el('select', { onchange: (e) => { dash.technician = e.target.value; refresh(); } },
    [el('option', { value: '' }, 'Everyone'), ...d.technicians.map((t) => el('option', { value: t.name }, t.name))]);
  tSel.value = dash.technician;

  mount(root, 
    el('div', { class: 'view-head' }, [el('h2', {}, 'Dashboard')]),
    el('div', { class: 'filters' }, [
      el('span', { class: 'label' }, 'Range'),
      el('div', { class: 'seg' }, ranges.map(([v, label]) => el('button', {
        class: dash.rangeDays === v ? 'on' : '', onclick: () => { dash.rangeDays = v; refresh(); },
      }, label))),
      el('span', { class: 'label' }, 'Machine'), mSel,
      el('span', { class: 'label' }, 'Technician'), tSel,
    ]),
    el('div', { class: 'kpis', id: 'kpis' }),
    el('div', { class: 'flags', id: 'flags' }),
    el('div', { class: 'grid2' }, [
      chartCard('hours', 'Hours by machine', 'Logged maintenance time in the selected range'),
      chartCard('breakdowns', 'Work orders by machine', 'Which machines break down the most'),
    ]),
    chartCard('trend', 'Work orders per week', 'New orders opened each week', 'margin-bottom:12px'),
  );
  renderKpis(d);
  renderFlags(d);
  renderHoursChart(d);
  renderBreakdownChart(d);
  renderTrendChart(d);
}
