/* Parts: everything needed / on order / received / used, with a copyable
   "what we need to order" list for purchasing. */

import {
  mount, el, api, toast, state, openModal, field, select, confirmDialog, copyText,
  fmtDate, daysAgo, machineName, woLabel, badge,
} from './core.js';
import { openWorkOrder } from './orders.js';

let statusFilter = 'outstanding';

export async function renderParts(root) {
  const [parts, orders] = await Promise.all([api('/api/parts'), api('/api/work-orders')]);
  const refresh = () => renderParts(root);
  const woById = new Map(orders.map((w) => [w.id, w]));
  const ORDER = { needed: 0, ordered: 1, received: 2, installed: 3 };

  const list = parts.filter((p) => statusFilter === 'all' ? true
    : statusFilter === 'outstanding' ? p.status !== 'installed' : p.status === statusFilter)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.createdAt.localeCompare(b.createdAt));

  const count = (s) => parts.filter((p) => p.status === s).length;
  const tabs = [
    ['outstanding', `Outstanding (${parts.filter((p) => p.status !== 'installed').length})`],
    ['needed', `Need to order (${count('needed')})`], ['ordered', `On order (${count('ordered')})`],
    ['received', `Received (${count('received')})`], ['installed', 'Used / installed'], ['all', 'All'],
  ];

  const orderListText = () => {
    const lines = ['PARTS TO ORDER', ''];
    for (const p of parts.filter((x) => x.status === 'needed')) {
      const wo = woById.get(p.workOrderId);
      lines.push(`• ${p.quantity} × ${p.name}${p.partNumber ? ' (' + p.partNumber + ')' : ''}${p.vendor ? ' — ' + p.vendor : ''}`
        + `${machineName(p.machineId) ? ' — for ' + machineName(p.machineId) : ''}${wo ? ' (' + woLabel(wo) + ')' : ''}`);
    }
    const ordered = parts.filter((x) => x.status === 'ordered');
    if (ordered.length) {
      lines.push('', 'ALREADY ON ORDER');
      for (const p of ordered) lines.push(`• ${p.quantity} × ${p.name}${p.partNumber ? ' (' + p.partNumber + ')' : ''}${p.vendor ? ' — ' + p.vendor : ''}`);
    }
    return lines.join('\n') + '\n';
  };

  const table = list.length ? el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, ['Part', 'Qty', 'Machine', 'Work order', 'Vendor', 'Requested', 'Status', ''].map((h, i) =>
      el('th', { class: [i === 1 ? 'num' : '', i === 4 || i === 5 ? 'hide-sm' : ''].join(' ') }, h)))),
    el('tbody', {}, list.map((p) => {
      const wo = woById.get(p.workOrderId);
      return el('tr', {}, [
        el('td', {}, [p.name, p.partNumber ? el('div', { class: 'muted small' }, p.partNumber) : null]),
        el('td', { class: 'num' }, String(p.quantity)),
        el('td', {}, machineName(p.machineId) || '—'),
        el('td', {}, wo ? el('a', { href: '#', onclick: (e) => { e.preventDefault(); openWorkOrder(wo.id, refresh); } }, `${woLabel(wo)} ${wo.title}`) : '—'),
        el('td', { class: 'hide-sm' }, p.vendor || '—'),
        el('td', { class: 'hide-sm nowrap' }, [p.requestedBy || '', el('div', { class: 'muted small' }, daysAgo(p.createdAt))]),
        el('td', {}, select(state.partStatuses, p.status, { class: 'inline', onchange: async (e) => {
          try {
            await api('/api/parts/' + p.id, { method: 'PATCH', body: { status: e.target.value } });
            toast(`${p.name} → ${e.target.value}`);
            refresh();
          } catch (err) { toast(err.message); }
        } })),
        el('td', { class: 'nowrap' }, [
          el('button', { class: 'ghost', onclick: () => openPartForm({ part: p, onDone: refresh }) }, 'Edit'),
        ]),
      ]);
    })),
  ]) : el('div', { class: 'empty' }, 'No parts here.');

  mount(root, 
    el('div', { class: 'view-head' }, [
      el('h2', {}, 'Parts'),
      el('span', { class: 'spacer' }),
      el('button', { onclick: () => copyText(orderListText()) }, 'Copy order list'),
      el('button', { class: 'primary', onclick: () => openPartForm({ onDone: refresh }) }, '+ Add part'),
    ]),
    el('div', { class: 'tabs-row' }, tabs.map(([v, label]) => el('button', {
      class: 'tab' + (statusFilter === v ? ' on' : ''), onclick: () => { statusFilter = v; refresh(); },
    }, label))),
    el('div', { class: 'card flush' }, el('div', { class: 'table-scroll' }, table)),
  );
}

export async function openPartForm({ part = null, workOrder = null, onDone } = {}) {
  let orders = [];
  try { orders = await api('/api/work-orders?status=open'); } catch { /* list stays empty */ }
  if (part && part.workOrderId && !orders.some((w) => w.id === part.workOrderId)) {
    try { orders.unshift((await api('/api/work-orders/' + part.workOrderId)).workOrder); } catch { /* deleted */ }
  }
  openModal(part ? 'Edit part' : 'Add part', (close) => {
    const f = {
      name: el('input', { value: part ? part.name : '', placeholder: 'e.g. spindle belt' }),
      partNumber: el('input', { value: part ? part.partNumber : '' }),
      quantity: el('input', { type: 'number', min: 1, value: part ? part.quantity : 1 }),
      vendor: el('input', { value: part ? part.vendor || '' : '', placeholder: 'optional' }),
      machine: el('input', { list: 'machine-list', value: part ? machineName(part.machineId) : (workOrder ? machineName(workOrder.machineId) : '') }),
      workOrderId: select([['', '— none —'], ...orders.map((w) => [w.id, `${woLabel(w)} — ${w.title}`])],
        part ? part.workOrderId || '' : (workOrder ? workOrder.id : '')),
      status: select(state.partStatuses, part ? part.status : 'needed'),
      notes: el('input', { value: part ? part.notes : '' }),
    };
    const save = async () => {
      if (!f.name.value.trim()) return toast('Part needs a name');
      const body = {
        name: f.name.value.trim(), partNumber: f.partNumber.value.trim(), quantity: Number(f.quantity.value) || 1,
        vendor: f.vendor.value.trim(), machineName: f.machine.value.trim(), workOrderId: f.workOrderId.value || null,
        status: f.status.value, notes: f.notes.value.trim(),
      };
      try {
        if (part) await api('/api/parts/' + part.id, { method: 'PATCH', body });
        else await api('/api/parts', { method: 'POST', body });
        toast(part ? 'Part updated' : 'Part added');
        close(); onDone && onDone();
      } catch (err) { toast(err.message); }
    };
    return el('div', {}, [
      el('div', { class: 'grid-form' }, [
        field('Part name', f.name), field('Part #', f.partNumber),
        field('Quantity', f.quantity), field('Vendor', f.vendor),
        field('Machine', f.machine), field('Work order', f.workOrderId),
        field('Status', f.status), field('Notes', f.notes),
      ]),
      part ? el('p', { class: 'muted small' }, [
        `Added ${fmtDate(part.createdAt)}${part.requestedBy ? ' by ' + part.requestedBy : ''}`,
        part.orderedAt ? ` · ordered ${fmtDate(part.orderedAt)}` : '',
        part.receivedAt ? ` · received ${fmtDate(part.receivedAt)}` : '',
        part.installedAt ? ` · installed ${fmtDate(part.installedAt)}` : '',
      ]) : null,
      el('div', { class: 'row-end' }, [
        part ? el('button', { class: 'danger ghost', onclick: async () => {
          if (!(await confirmDialog(`Delete “${part.name}” from the parts list?`))) return;
          await api('/api/parts/' + part.id, { method: 'DELETE' });
          toast('Part deleted'); close(); onDone && onDone();
        } }, 'Delete') : null,
        el('span', { class: 'spacer' }),
        el('button', { class: 'ghost', onclick: close }, 'Cancel'),
        el('button', { class: 'primary', onclick: save }, part ? 'Save' : 'Add part'),
      ]),
    ]);
  });
}

export { badge };
