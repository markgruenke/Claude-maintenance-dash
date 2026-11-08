/* The detailed work-entry form (the voice/typed box on Today is the quick
   way). Two modes:
     mode 'log'  — log work with every field spelled out
     mode 'edit' — fix an existing entry (e.g. a mis-heard voice entry)
   Built for a tablet: big targets, chips for common values, and only one
   required field ("what was done"). */

import {
  el, api, toast, state, isSupervisor, isShared, openModal, field, select, segmented,
  machineName, woLabel, localDate, parsePartList, uid, statusText,
} from './core.js';

const TIME_CHIPS = [[15, '15m'], [30, '30m'], [45, '45m'], [60, '1h'], [90, '1.5h'], [120, '2h'], [180, '3h'], [240, '4h']];
const RESULTS = [['completed', 'Done'], ['in_progress', 'Still open'], ['waiting_parts', 'Waiting on parts']];

function recentMachines() {
  try { return JSON.parse(localStorage.getItem('mt_recent_machines') || '[]'); } catch { return []; }
}
function rememberMachine(name) {
  if (!name) return;
  const list = [name, ...recentMachines().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 8);
  try { localStorage.setItem('mt_recent_machines', JSON.stringify(list)); } catch { /* ignore */ }
}

/** Supervisors on the shared system can log work for someone else. */
export const canLogForOthers = () => isSupervisor() && isShared();

export function currentWorker() {
  try { return (canLogForOthers() && localStorage.getItem('mt_worker')) || state.me.name; } catch { return state.me.name; }
}

/**
 * @param {object} o
 * @param {'log'|'edit'} o.mode
 * @param {object} [o.log]        existing entry (edit)
 * @param {object} [o.workOrder]  pre-selected work order
 * @param {string} [o.date]       default date
 * @param {Function} [o.onDone]
 */
export async function openLogForm(o = {}) {
  const mode = o.mode || 'log';
  const log = o.log || null;
  let openOrders = [];
  try { openOrders = await api('/api/work-orders?status=open'); } catch (err) { toast(err.message); }

  let presetWo = o.workOrder || (log && log.workOrderId ? openOrders.find((w) => w.id === log.workOrderId) : null);
  // Editing an entry whose job is already finished: that job isn't in the
  // open list, but the entry must stay attached to it.
  if (!presetWo && log && log.workOrderId) {
    try { presetWo = (await api('/api/work-orders/' + log.workOrderId)).workOrder; } catch { /* job was deleted */ }
  }
  // Parts this entry recorded (so they can be corrected).
  let entryParts = [];
  if (mode === 'edit' && log) {
    try { entryParts = (await api('/api/parts')).filter((p) => p.logId === log.id); } catch (err) { toast(err.message); }
  }
  const partText = (list) => list.map((p) => (p.quantity > 1 ? `${p.quantity}x ` : '') + p.name).join(', ');
  const initialMachine = presetWo ? machineName(presetWo.machineId) : (log ? machineName(log.machineId) : '');

  const title = { log: 'Log work', edit: 'Edit entry' }[mode];

  openModal(title, (close) => {
    // ---- machine
    const machineInput = el('input', { list: 'machine-list', value: initialMachine, placeholder: 'Machine or area (e.g. CNC 3)', autocomplete: 'off', class: 'big' });
    const chipBox = el('div', { class: 'chips' });
    const drawChips = () => {
      const names = recentMachines();
      chipBox.replaceChildren(...names.map((n) => el('button', {
        type: 'button', class: 'chip' + (n.toLowerCase() === machineInput.value.trim().toLowerCase() ? ' on' : ''),
        onclick: () => { machineInput.value = n; onMachineChange(); },
      }, n)));
    };

    // ---- job: free text. Suggestions list open work orders; picking one
    // (or typing its number) puts the entry on it. Anything else becomes
    // the job's name.
    const listId = 'job-options-' + Math.random().toString(36).slice(2, 8);
    const jobList = el('datalist', { id: listId });
    const jobInput = el('input', {
      class: 'big', list: listId, autocomplete: 'off',
      value: presetWo ? presetWo.title : '',
      placeholder: mode === 'edit' ? 'What the job is' : 'What the job is (leave blank to use the first words of the notes)',
    });
    const initialJob = jobInput.value;
    const plexNumber = el('input', {
      value: presetWo ? presetWo.orderNumber || '' : '', placeholder: 'e.g. 10288', inputmode: 'numeric', autocomplete: 'off',
    });
    const initialPlex = plexNumber.value;
    const priority = select(state.priorities, 'medium');
    const fillJobs = () => {
      const mName = machineInput.value.trim().toLowerCase();
      const m = state.machines.find((x) => x.name.toLowerCase() === mName);
      // This machine's open jobs first, then the rest.
      const list = [...openOrders].sort((x, y) => (m && y.machineId === m.id ? 1 : 0) - (m && x.machineId === m.id ? 1 : 0));
      if (presetWo && !list.some((w) => w.id === presetWo.id)) list.unshift(presetWo);
      jobList.replaceChildren(...list.map((w) => el('option', {
        value: `${woLabel(w)} — ${w.title}`,
      }, [machineName(w.machineId), statusText(w.status)].filter(Boolean).join(' · '))));
    };
    const onMachineChange = () => { fillJobs(); drawChips(); };
    machineInput.addEventListener('change', onMachineChange);
    fillJobs();
    drawChips();
    const jobHint = mode === 'edit'
      ? 'Type anything. Pick a suggestion (or type its number, like NO_WO#003) to move this entry onto that work order.'
      : 'Type anything, or pick one of your open work orders.';

    // ---- notes
    const notes = el('textarea', {
      class: 'big', rows: 4,
      placeholder: 'What did you do / find? (tap the mic on the keyboard to dictate)',
    });
    notes.value = log ? log.notes : '';

    // ---- time
    let minutes = log ? log.minutes : null;
    const minutesInput = el('input', { type: 'number', min: 0, step: 5, inputmode: 'numeric', placeholder: 'min', class: 'mins' });
    const timeChips = el('div', { class: 'chips' });
    const drawTime = () => {
      timeChips.replaceChildren(...TIME_CHIPS.map(([v, label]) => el('button', {
        type: 'button', class: 'chip' + (Number(minutes) === v ? ' on' : ''),
        onclick: () => { minutes = v; minutesInput.value = v; drawTime(); },
      }, label)));
    };
    minutesInput.addEventListener('input', () => { minutes = minutesInput.value === '' ? null : Number(minutesInput.value); drawTime(); });
    if (minutes != null) minutesInput.value = minutes;
    drawTime();

    // ---- result + parts
    const initialStatus = mode === 'edit' ? (presetWo ? presetWo.status : null) : 'completed';
    const result = segmented(RESULTS, initialStatus);
    const partsUsed = el('input', { placeholder: 'e.g. drive belt, 2x bearing', class: 'big' });
    const partsNeeded = el('input', { placeholder: 'e.g. coolant pump, 4x filter', class: 'big' });
    if (mode === 'edit') {
      partsUsed.value = partText(entryParts.filter((p) => p.status === 'installed'));
      partsNeeded.value = partText(entryParts.filter((p) => p.status !== 'installed'));
    }
    let hadNeeded = !!partsNeeded.value.trim();
    partsNeeded.addEventListener('input', () => {
      const hasNeeded = !!partsNeeded.value.trim();
      if (hasNeeded && result.value !== 'waiting_parts') result.value = 'waiting_parts';
      // Cleared the only reason it was waiting: it's not waiting on parts any more.
      if (!hasNeeded && hadNeeded && result.value === 'waiting_parts') result.value = 'in_progress';
      hadNeeded = hasNeeded;
    });
    // Parts that already moved along (ordered / received) say so, so it's
    // clear what editing them affects.
    const progressed = entryParts.filter((p) => ['ordered', 'received'].includes(p.status));
    const neededHint = mode === 'edit'
      ? (progressed.length ? `Already ${progressed.map((p) => `${p.name}: ${p.status}`).join(', ')}. Removing a part here deletes it from the parts list.` : 'Removing a part here deletes it from the parts list.')
      : 'Added to the parts list';

    // ---- who/when
    const date = el('input', { type: 'date', value: (log && log.date) || o.date || localDate() });
    const tech = canLogForOthers()
      ? el('input', { list: 'tech-list', value: log ? log.technician : currentWorker() })
      : null;

    const saveBtn = el('button', { class: 'primary big', type: 'button' }, 'Save');

    async function save() {
      if (!notes.value.trim()) {
        toast('Write a few words about what you did');
        notes.focus();
        return;
      }
      const body = {
        clientId: log ? undefined : uid(),
        date: date.value,
        machineName: machineInput.value.trim(),
        notes: notes.value.trim(),
        ...(tech ? { technician: tech.value.trim() } : {}),
      };
      const jobText = jobInput.value.trim();
      if (mode === 'log') {
        // Opened from a work order and its name left as is: log on that order.
        if (presetWo && jobText === initialJob) body.workOrderId = presetWo.id;
        else body.jobText = jobText;
        if (plexNumber.value.trim()) body.orderNumber = plexNumber.value.trim();
        body.priority = priority.value;
      }
      body.minutes = minutes == null ? 0 : minutes;
      if (mode === 'log') {
        body.statusAfter = result.value;
        body.partsUsed = parsePartList(partsUsed.value);
        body.partsNeeded = parsePartList(partsNeeded.value);
      }
      saveBtn.disabled = true;
      try {
        let out;
        if (mode === 'log') out = await api('/api/work-logs', { method: 'POST', body, queue: true });
        else {
          const patch = {
            date: body.date, machineName: body.machineName, notes: body.notes, minutes: body.minutes,
            partsUsed: parsePartList(partsUsed.value),
            partsNeeded: parsePartList(partsNeeded.value),
          };
          if (jobText && jobText !== initialJob) patch.jobText = jobText;
          if (plexNumber.value.trim() !== initialPlex) patch.orderNumber = plexNumber.value.trim();
          if (result.value && result.value !== initialStatus) patch.statusAfter = result.value;
          if (tech) patch.technician = body.technician;
          out = await api(`/api/work-logs/${log.id}`, { method: 'PATCH', body: patch });
        }
        rememberMachine(body.machineName);
        if (tech && mode !== 'edit') { try { localStorage.setItem('mt_worker', body.technician); } catch { /* ignore */ } }
        close();
        if (!out.queued) {
          toast({
            log: 'Work logged',
            edit: 'Entry updated',
          }[mode]);
        }
        o.onDone && o.onDone(out);
      } catch (err) {
        toast(err.message, 4000);
        saveBtn.disabled = false;
      }
    }
    saveBtn.addEventListener('click', save);

    return el('div', { class: 'logform' }, [
      field('Machine', machineInput),
      chipBox,
      field('Job', jobInput, jobHint),
      jobList,
      el('div', { class: 'row2' }, [
        field('Plex WO# (optional)', plexNumber, mode === 'edit' ? 'Add it once you have it; the job then shows this number' : 'Leave blank to get a NO_WO# number'),
        mode === 'log' ? field('Priority', priority) : el('span'),
      ]),
      field('What was done', notes),
      el('div', { class: 'fld' }, [
        el('span', { class: 'fld-label' }, 'Time spent (optional)'),
        el('div', { class: 'time-row' }, [timeChips, el('span', { class: 'or' }, 'or'), minutesInput, el('span', { class: 'muted' }, 'min')]),
      ]),
      el('div', { class: 'row2' }, [
        field('Parts used', partsUsed, 'Separate with commas, e.g. 2x bearing'),
        field('Parts needed', partsNeeded, neededHint),
      ]),
      (mode === 'log' || presetWo) ? el('div', { class: 'fld' }, [
        el('span', { class: 'fld-label' }, mode === 'edit' ? 'Where does the job stand?' : 'Where does it stand?'), result.node,
      ]) : null,
      el('div', { class: 'row2' }, [field('Date', date), tech ? field('Technician', tech, 'Supervisors can log for anyone') : el('span')]),
      el('div', { class: 'row-end sticky' }, [el('button', { class: 'ghost big', type: 'button', onclick: close }, 'Cancel'), saveBtn]),
    ]);
  }, { wide: true });
}

/** Paste free-form notes -> parser preview -> save. */
export function openNotesForm({ onDone, date } = {}) {
  openModal('Log from notes', (close) => {
    const text = el('textarea', { rows: 6, class: 'big', placeholder: 'Example: Spent 2 hrs on CNC 3, replaced the spindle belt. Still need to order a coolant pump.' });
    const dateIn = el('input', { type: 'date', value: date || localDate() });
    const tech = canLogForOthers() ? el('input', { list: 'tech-list', value: currentWorker() }) : null;
    const preview = el('div');
    const saveBtn = el('button', { class: 'primary big', disabled: true }, 'Save entry');

    const doPreview = async () => {
      if (!text.value.trim()) return toast('Paste some notes first');
      try {
        const p = await api('/api/ingest/notes/preview', { method: 'POST', body: { text: text.value } });
        const row = (k, v) => el('div', { class: 'pv-row' }, [el('span', { class: 'pv-key' }, k), el('span', {}, v || '—')]);
        preview.replaceChildren(el('div', { class: 'preview' }, [
          el('h4', {}, 'What it picked up'),
          row('Machine', p.machineName),
          row('WO#', p.orderNumber),
          row('Time spent', p.minutes != null ? `${p.minutes} min` : ''),
          row('Parts used', p.partsUsed.join(', ')),
          row('Parts needed', p.partsNeeded.join(', ')),
          row('Status', statusText(p.statusHint)),
          el('p', { class: 'fld-hint' }, 'Wrong? Edit the text and preview again, or use “Log work” for the full form.'),
        ]));
        saveBtn.disabled = false;
      } catch (err) { toast(err.message); }
    };
    saveBtn.addEventListener('click', async () => {
      try {
        const out = await api('/api/ingest/notes', {
          method: 'POST',
          body: { text: text.value.trim(), date: dateIn.value, ...(tech ? { technician: tech.value.trim() } : {}) },
        });
        close();
        toast(out.createdOrder ? 'Logged — new work order created' : 'Work logged');
        onDone && onDone(out);
      } catch (err) { toast(err.message); }
    });

    return el('div', {}, [
      el('p', { class: 'desc' }, 'Paste notes you already wrote (texts, chat). It pulls out the machine, time, parts used and parts needed — check the preview before saving.'),
      field('Notes', text),
      el('div', { class: 'row2' }, [field('Date', dateIn), tech ? field('Technician', tech) : el('span')]),
      el('div', { class: 'row-end' }, [el('button', { onclick: doPreview }, 'Preview')]),
      preview,
      el('div', { class: 'row-end' }, [el('button', { class: 'ghost', onclick: close }, 'Cancel'), saveBtn]),
    ]);
  });
}
