/* "Today": the tablet screen. Tap the mic, say what you did, and it's
   logged. The day's entries build up below, ready for the end-of-day list. */

import {
  mount, el, api, toast, state, isSupervisor, fmtHours, fmtDay, fmtTime, localDate, uid, copyText, confirmDialog, TZ,
  woLabel, machineName, statusText,
} from './core.js';
import { openLogForm, openNotesForm, currentWorker, canLogForOthers } from './logform.js';
import { openWorkOrder } from './orders.js';
import { voiceSupport, listen, resetVoiceCheck } from './voice.js';
import { backupNow, lastBackupAt } from './team.js';

let viewDate = localDate();
let session = null; // active voice session

const STATUS_WORDS = {
  completed: ['done', 'good'], in_progress: ['still open', 'warn'], waiting_parts: ['waiting on parts', 'warn'],
  open: ['open', 'warn'], cancelled: ['cancelled', ''],
};

export async function renderToday(root) {
  if (session) return; // never redraw under someone who's talking
  const worker = currentWorker();
  const [report, openOrders] = await Promise.all([
    api(`/api/reports?from=${viewDate}&to=${viewDate}&technician=${encodeURIComponent(worker)}&tz=${encodeURIComponent(TZ)}`),
    api('/api/work-orders?status=open'),
  ]);
  const refresh = () => renderToday(root);
  const entries = [...report.entries].reverse(); // newest first
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  const notEntered = entries.filter((e) => !e.entered).length;
  const isToday = viewDate === localDate();

  // ---- header
  const dateInput = el('input', { type: 'date', value: viewDate, onchange: (e) => { viewDate = e.target.value || localDate(); refresh(); } });
  const whoBox = canLogForOthers()
    ? el('label', { class: 'inline-fld' }, ['Logging as ', (() => {
      const names = [...new Set([state.me.name, ...state.users.map((u) => u.name), ...state.technicians])];
      const s = el('select', { onchange: (e) => { try { localStorage.setItem('mt_worker', e.target.value); } catch { /* */ } refresh(); } },
        names.map((n) => el('option', { value: n }, n)));
      s.value = worker;
      return s;
    })()])
    : null;

  const voice = voiceCard(worker, refresh);

  mount(root,
    el('div', { class: 'today-head' }, [
      el('h2', {}, isToday ? 'Today' : fmtDay(viewDate)),
      dateInput,
      el('span', { class: 'spacer' }),
      whoBox,
    ]),
    backupReminder(refresh),
    voice.node,
    assignedCard(openOrders, worker, voice, refresh),
    el('div', { class: 'card' }, [
      el('h2', {}, [
        `${isToday ? 'Today’s' : fmtDay(viewDate)} work`,
        el('span', { class: 'muted small' }, ` · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${fmtHours(total)}${notEntered ? ` · ${notEntered} not entered yet` : ''}`),
        el('span', { class: 'spacer' }),
        entries.length ? el('button', { class: 'ghost', onclick: () => copyText(report.dailyText) }, 'Copy list') : null,
        el('a', { class: 'btn ghost', href: `#reports?preset=custom&from=${viewDate}&to=${viewDate}&tab=daily&technician=${encodeURIComponent(worker)}` }, 'End-of-day list →'),
      ]),
      entries.length
        ? el('div', { class: 'entries' }, entries.map((e) => entryCard(e, refresh)))
        : el('div', { class: 'empty' }, 'Nothing logged yet. Tap the microphone and say what you did.'),
    ]),
  );
}

/** Tablet app only: the log lives on this device, so nag gently about backups. */
function backupReminder(refresh) {
  if (!state.local || !state.machines.length) return null; // nothing logged yet
  const last = lastBackupAt();
  const ageDays = last ? (Date.now() - Date.parse(last)) / 86400000 : Infinity;
  if (ageDays < 7) return null;
  return el('div', { class: 'backup-nag' }, [
    el('span', {}, last ? `Last backup was ${Math.floor(ageDays)} days ago. Your log only lives on this tablet.` : 'Your log only lives on this tablet. Save a backup now and then.'),
    el('span', { class: 'spacer' }),
    navigator.canShare ? el('button', { onclick: () => backupNow({ share: true }).then(refresh).catch((e) => toast(e.message)) }, 'Send backup') : null,
    el('button', { class: 'primary', onclick: () => backupNow().then(refresh).catch((e) => toast(e.message)) }, 'Save backup'),
  ]);
}

// --------------------------------------------------------- assigned to you

// Orders made from someone's spoken/typed entry, as opposed to ones put in
// on the Work Orders tab, from an email, or by a PM schedule.
const FROM_ENTRY = ['voice', 'typed', 'notes', 'tablet'];
const RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Work orders put in for you to do (on the Work Orders tab, by email, or by
 * a PM schedule) that are still open: assigned to you, plus unassigned ones
 * so nothing falls through the cracks.
 */
function assignedCard(openOrders, worker, voice, refresh) {
  const today = localDate();
  const list = openOrders
    .filter((w) => !FROM_ENTRY.includes(w.source) && (!w.assignedTo || w.assignedTo === worker))
    .sort((a, b) => {
      const od = (w) => (w.dueDate && w.dueDate < today ? 0 : 1);
      return od(a) - od(b) || RANK[a.priority] - RANK[b.priority]
        || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))
        || a.createdAt.localeCompare(b.createdAt);
    });
  return el('div', { class: 'card' }, [
    el('h2', {}, [`Assigned to you`, el('span', { class: 'muted small' }, ` · ${list.length} open`)]),
    list.length
      ? el('div', { class: 'assigned' }, list.map((w) => {
        const overdue = w.dueDate && w.dueDate < today;
        return el('div', { class: 'assigned-row' + (overdue ? ' is-overdue' : '') }, [
          el('button', { class: 'assigned-main', type: 'button', onclick: () => openWorkOrder(w.id, refresh) }, [
            el('div', { class: 'assigned-title' }, [
              el('span', { class: 'wo-num' }, woLabel(w)), ' ',
              el('strong', {}, machineName(w.machineId) || ''), machineName(w.machineId) ? ' — ' : '', w.title,
            ]),
            el('div', { class: 'entry-facts' }, [
              ['urgent', 'high'].includes(w.priority) ? el('span', { class: 'fact warn' }, w.priority) : null,
              el('span', { class: 'fact' }, statusText(w.status)),
              w.dueDate ? el('span', { class: 'fact' + (overdue ? ' bad' : '') }, (overdue ? 'overdue · was due ' : 'due ') + fmtDay(w.dueDate)) : null,
              w.source === 'pm' ? el('span', { class: 'fact' }, 'PM') : null,
              !w.assignedTo ? el('span', { class: 'fact muted' }, 'unassigned') : null,
              w.createdBy && w.createdBy !== worker && w.createdBy !== 'PM scheduler' ? el('span', { class: 'fact muted' }, 'from ' + w.createdBy) : null,
            ]),
          ]),
          el('button', { class: 'log-on', type: 'button', onclick: () => voice.logOn(w) }, '🎤 Log'),
        ]);
      }))
      : el('div', { class: 'empty small' }, 'Nothing assigned right now. Work orders put in on the Work Orders tab show up here.'),
  ]);
}

// ------------------------------------------------------------- voice card

function voiceCard(worker, refresh) {
  let support = voiceSupport();
  const text = el('textarea', {
    class: 'voice-text', rows: 3,
    placeholder: support.ok
      ? 'Or type here…'
      : 'Tap here, then tap the 🎤 on your keyboard and talk',
  });
  const label = el('div', { class: 'mic-label' }, support.ok ? 'Tap and say what you did' : 'Tap, then use the keyboard 🎤');
  const example = el('div', { class: 'mic-example' }, '“Press 2, replaced the drive belt, about an hour, parts used drive belt, parts needed belt guard.”');
  const mic = el('button', { class: 'mic-btn', type: 'button', 'aria-label': 'Start talking' }, micIcon());
  const saveBtn = el('button', { class: 'primary big', type: 'button' }, 'Save');
  const tip = el('div', { class: 'voice-tip', hidden: true });
  // When set, the next entry goes onto this work order (from "Assigned to you").
  let target = null;
  const forBar = el('div', { class: 'for-bar', hidden: true });
  const drawFor = () => {
    forBar.hidden = !target;
    if (!target) { forBar.replaceChildren(); return; }
    forBar.replaceChildren(
      el('span', {}, ['Logging on ', el('strong', {}, woLabel(target)), ` — ${[machineName(target.machineId), target.title].filter(Boolean).join(' — ')}`]),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost small-btn', type: 'button', onclick: () => { target = null; drawFor(); } }, '✕ Not this one'),
    );
  };

  const date = viewDate;

  async function save(source) {
    const body = text.value.trim();
    if (!body) { toast('Say or type what you did first'); return; }
    saveBtn.disabled = true;
    const payload = {
      text: body, date, clientId: uid(), source,
      ...(target ? { workOrderId: target.id } : {}),
      ...(canLogForOthers() ? { technician: worker } : {}),
    };
    try {
      const out = await api('/api/ingest/notes', { method: 'POST', body: payload, queue: true });
      text.value = '';
      target = null;
      drawFor();
      if (out.queued) { refresh(); return; }
      const bits = [out.log && out.workOrder ? (state.machines.find((m) => m.id === out.log.machineId) || {}).name : '',
        out.log && out.log.minutes ? fmtHours(out.log.minutes) : '',
        out.workOrder ? (STATUS_WORDS[out.workOrder.status] || [''])[0] : ''].filter(Boolean);
      toast('Logged' + (bits.length ? ': ' + bits.join(' · ') : ''), 7000, {
        label: 'Undo',
        fn: async () => {
          try { await api('/api/work-logs/' + out.log.id, { method: 'DELETE' }); toast('Removed'); refresh(); }
          catch (err) { toast(err.message); }
        },
      });
      refresh();
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener('click', () => save('typed'));

  mic.addEventListener('click', () => {
    if (!support.ok) {
      // Built-in recognition isn't available here: hand off to the keyboard's mic.
      tip.hidden = false;
      const why = {
        insecure: 'The big mic button needs a secure (https) address; on this Wi-Fi address the browser blocks it.',
        'ios-browser': 'On iPad and iPhone, only Safari can use built-in voice input, so in this browser use the keyboard’s.',
        'didnt-start': 'Built-in voice input didn’t start in this browser earlier, so this device uses the keyboard’s.',
        browser: 'This browser doesn’t have built-in voice input.',
      }[support.reason] || '';
      mount(tip,
        el('strong', {}, 'Use the 🎤 key on your keyboard. '),
        why + ' Tap the box below, tap 🎤 on the keyboard, talk, then tap Save.',
        support.reason === 'didnt-start' ? el('button', { class: 'ghost small-btn', onclick: () => { resetVoiceCheck(); support = voiceSupport(); tip.hidden = true; toast('OK, the mic button will try built-in voice again'); } }, 'Try built-in voice again') : null,
      );
      text.focus();
      return;
    }
    if (session) { session.stop(); return; } // second tap = done
    const before = text.value.trim();
    mic.classList.add('listening');
    mic.setAttribute('aria-label', 'Stop and save');
    label.textContent = 'Listening… tap when you’re done';
    example.hidden = true;
    session = listen({
      onText: (t) => { text.value = [before, t].filter(Boolean).join(' '); },
      onDone: (t) => {
        session = null;
        mic.classList.remove('listening');
        mic.setAttribute('aria-label', 'Start talking');
        label.textContent = 'Tap and say what you did';
        example.hidden = false;
        text.value = [before, t].filter(Boolean).join(' ');
        if (t) save('voice');
        else toast('Didn’t catch anything. Tap the mic and try again.');
      },
      onError: (msg, info) => {
        session = null;
        mic.classList.remove('listening');
        mic.setAttribute('aria-label', 'Start talking');
        example.hidden = false;
        if (info && info.fallback) {
          // Switch this screen to keyboard-mic mode right away.
          support = voiceSupport();
          label.textContent = 'Tap, then use the keyboard 🎤';
          text.placeholder = 'Tap here, then tap the 🎤 on your keyboard and talk';
          tip.hidden = false;
          tip.replaceChildren(el('strong', {}, 'Use the 🎤 key on your keyboard. '), 'Built-in voice input didn’t start in this browser. Tap the box below, tap 🎤 on the keyboard, talk, then tap Save.');
          text.focus();
          return;
        }
        label.textContent = 'Tap and say what you did';
        toast(msg, 6000);
      },
    });
  });

  /** Aim the next entry at a work order, then start listening (or open the
   *  keyboard for its mic). Runs inside the tap, so the browser allows it. */
  function logOn(wo) {
    target = wo;
    drawFor();
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (support.ok) { if (!session) mic.click(); }
    else { mic.click(); }
  }

  const node = el('div', { class: 'voice-card' }, [
    forBar,
    el('div', { class: 'mic-wrap' }, [mic, label, example]),
    tip,
    text,
    el('div', { class: 'voice-actions' }, [
      el('button', { class: 'ghost', type: 'button', onclick: () => openLogForm({ mode: 'log', date, onDone: refresh }) }, 'Detailed entry'),
      el('button', { class: 'ghost', type: 'button', onclick: () => openNotesForm({ date, onDone: refresh }) }, 'Paste notes'),
      el('span', { class: 'spacer' }),
      saveBtn,
    ]),
  ]);
  return { node, logOn };
}

function micIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/>'
    + '<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return svg;
}

// ------------------------------------------------------------- entry card

function entryCard(e, refresh) {
  const check = el('input', {
    type: 'checkbox', checked: e.entered, 'aria-label': 'Entered in company system',
    onchange: async (ev) => {
      try { await api(`/api/work-logs/${e.id}`, { method: 'PATCH', body: { entered: ev.target.checked } }); refresh(); }
      catch (err) { toast(err.message); ev.target.checked = !ev.target.checked; }
    },
  });
  const [statusWord, statusCls] = STATUS_WORDS[e.workOrderStatus] || ['', ''];
  return el('div', { class: 'entry' + (e.entered ? ' is-entered' : '') }, [
    el('div', { class: 'entry-time' }, fmtTime(e.loggedAt)),
    el('div', { class: 'entry-main' }, [
      el('div', { class: 'entry-notes' }, e.notes),
      el('div', { class: 'entry-facts' }, [
        e.machineName ? el('span', { class: 'fact' }, e.machineName) : el('span', { class: 'fact muted' }, 'no machine'),
        e.minutes ? el('span', { class: 'fact' }, fmtHours(e.minutes)) : null,
        statusWord ? el('span', { class: 'fact ' + statusCls }, statusWord) : null,
        e.workOrderLabel && e.workOrderId ? el('a', { href: '#', class: 'fact link', onclick: (ev) => { ev.preventDefault(); openWorkOrder(e.workOrderId, refresh); } }, e.workOrderLabel) : null,
        e.partsUsed.length ? el('span', { class: 'fact' }, 'used: ' + e.partsUsed.join(', ')) : null,
        e.partsNeeded.length ? el('span', { class: 'fact warn' }, 'need: ' + e.partsNeeded.join(', ')) : null,
        !isMine(e) ? el('span', { class: 'fact muted' }, e.technician) : null,
      ]),
    ]),
    el('div', { class: 'entry-actions' }, [
      el('label', { class: 'entered', title: 'Tick once it’s in the company system' }, [check, ' Entered']),
      el('button', { class: 'ghost', onclick: async () => {
        const log = (await api(`/api/work-logs?from=${e.date}&to=${e.date}`)).find((l) => l.id === e.id);
        if (log) openLogForm({ mode: 'edit', log, onDone: refresh });
      } }, 'Edit'),
      el('button', { class: 'ghost', onclick: async () => {
        if (!(await confirmDialog('Delete this entry? Parts it added, and a job it opened that has nothing else logged, go too.'))) return;
        await api(`/api/work-logs/${e.id}`, { method: 'DELETE' });
        toast('Entry deleted');
        refresh();
      } }, 'Delete'),
    ]),
  ]);
}

function isMine(e) {
  return e.technician === currentWorker();
}
