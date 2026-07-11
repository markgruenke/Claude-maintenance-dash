'use strict';
/**
 * Best-effort text parsers for the two ingestion paths:
 *
 *  1. parseEmail  — a Plex work-order notification email (subject + body).
 *  2. parseNotes  — free-form technician notes pasted from chat.
 *
 * Both return structured suggestions, never write to the store directly.
 * The server layer decides what to create, and the UI shows a preview the
 * user can correct before committing — parsing is assistance, not gospel.
 */

// ------------------------------------------------------------------ email

const PRIORITY_WORDS = [
  [/\b(urgent|emergency|critical|down\b|line down|asap)\b/i, 'urgent'],
  [/\bhigh\b/i, 'high'],
  [/\blow\b/i, 'low'],
];

/** Pull a work order number out of text: "WO#12345", "WO-12345",
 *  "Work Order 12345", "Order #12345". */
function extractOrderNumber(text) {
  const patterns = [
    /\bW\.?O\.?\s*[#:-]?\s*(\d{3,})/i,
    /\bwork\s*order\s*(?:number|no\.?|num)?\s*[#:-]?\s*(\d{3,})/i,
    /\border\s*[#:]\s*(\d{3,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return '';
}

/** Pull a machine name from labeled lines like "Machine: CNC 3",
 *  "Equipment: Press 2", "Asset: Lathe 1". */
function extractLabeledMachine(text) {
  const m = text.match(/^\s*(?:machine|equipment|asset|work\s*center|workcenter)\s*(?:name|id|no\.?)?\s*[:\-]\s*(.+)$/im);
  return m ? m[1].trim() : '';
}

function extractPriority(text) {
  const labeled = text.match(/^\s*priority\s*[:\-]\s*(.+)$/im);
  const scope = labeled ? labeled[1] : text;
  for (const [re, level] of PRIORITY_WORDS) {
    if (re.test(scope)) return level;
  }
  return 'medium';
}

/**
 * @param {{subject?: string, body?: string, from?: string, receivedAt?: string}} email
 */
function parseEmail(email) {
  const subject = String(email.subject || '').trim();
  const body = String(email.body || '').trim();
  const all = subject + '\n' + body;

  const orderNumber = extractOrderNumber(all);
  let machineName = extractLabeledMachine(body) || extractLabeledMachine(subject);

  // Fallback: "CNC 3 is down", "issue on Press 2" style phrases.
  if (!machineName) {
    const m = all.match(/(?:\bon\b|\bat\b|\bwith\b)?\s*\b([A-Z][A-Za-z0-9/-]*(?:\s+[A-Za-z0-9/#-]+){0,3}?)\s+(?:is|was|went|keeps?|won'?t|has|needs?)\b/);
    if (m) machineName = m[1].trim();
  }

  // Description: labeled field first, otherwise the body itself.
  let description = '';
  const desc = body.match(/^\s*(?:description|issue|problem|details?)\s*[:\-]\s*([\s\S]*?)(?=^\s*\w[\w\s]*:|\s*$)/im);
  if (desc) description = desc[1].trim();
  if (!description) description = body;

  // Title: subject minus boilerplate prefixes, else first line of description.
  let title = subject
    .replace(/^\s*(?:fwd?|re)\s*:\s*/i, '')
    .replace(/^\s*(?:plex\s*)?(?:new\s*)?work\s*order\s*(?:notification|created|assigned)?\s*[:\-#]*\s*/i, '')
    .replace(/^\s*W\.?O\.?\s*[#:-]?\s*\d{3,}\s*[-–:]?\s*/i, '')
    .trim();
  if (!title) title = (description.split('\n')[0] || 'Work order from email').slice(0, 120);

  return {
    orderNumber,
    machineName,
    title,
    description,
    priority: extractPriority(all),
    receivedAt: email.receivedAt || null,
    from: email.from || '',
  };
}

// ------------------------------------------------------------------ notes

/** "2h", "2 hrs", "1.5 hours", "45 min", "90 minutes", "2h 30m", "spent 2 hours" */
function extractMinutes(text) {
  let minutes = 0;
  let found = false;
  const hm = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b(?:\s*(?:and\s*)?(\d+)\s*(?:m|min|mins|minutes)\b)?/i);
  if (hm) {
    minutes += Math.round(parseFloat(hm[1]) * 60);
    if (hm[2]) minutes += parseInt(hm[2], 10);
    found = true;
  } else {
    const mo = text.match(/(\d+)\s*(?:m|min|mins|minutes)\b/i);
    if (mo) {
      minutes += parseInt(mo[1], 10);
      found = true;
    }
  }
  return found ? minutes : null;
}

/** Split "bearings and a drive belt", "seal, gasket and hose" into part names. */
function splitPartList(text) {
  return text
    .split(/,|\band\b|&|\+/i)
    .map((s) => s.replace(/^\s*(?:a|an|the|some|new|couple of|few)\s+/i, '').replace(/[.;]\s*$/, '').trim())
    .filter((s) => s && s.length > 1 && !/^\d+$/.test(s));
}

const PARTS_USED_RES = [
  /\b(?:used|replaced|installed|swapped(?:\s+in)?|put\s+(?:in|on))\s+(?:a\s+|an\s+|the\s+|new\s+|some\s+)?([^.;\n]+?)(?=\s+(?:on|in|at|for)\s+|[.;\n]|$)/gi,
];

const PARTS_NEEDED_RES = [
  /\b(?:need(?:s|ed)?(?:\s+to\s+order)?|ordering|ordered|waiting\s+(?:on|for)|out\s+of\s+stock\s+on)\s+(?:a\s+|an\s+|the\s+|new\s+|some\s+)?([^.;\n]+?)(?=\s+(?:on|in|at|for|from)\s+|[.;\n]|$)/gi,
];

const DONE_RE = /\b(?:fixed|repaired|resolved|back\s+up(?:\s+and\s+running)?|running\s+again|completed?|done|good\s+to\s+go)\b/i;
const WAITING_RE = /\b(?:waiting\s+(?:on|for)|need\s+to\s+order|on\s+order|parts?\s+(?:on\s+order|ordered))\b/i;

/**
 * Parse a free-form note. If knownMachines (array of names) is given, machine
 * detection checks those first, which is far more reliable than patterns.
 *
 * @returns {{machineName, orderNumber, minutes, partsUsed, partsNeeded,
 *            statusHint, notes}}
 */
function parseNotes(text, knownMachines = []) {
  const src = String(text || '').trim();

  // Known machine names beat regex guessing; prefer the longest match so
  // "CNC 3" doesn't steal a note about "CNC 31".
  let machineName = '';
  const sorted = [...knownMachines].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (!name) continue;
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(src)) { machineName = name; break; }
  }
  if (!machineName) {
    const m = src.match(/\b(?:on|at)\s+(?:the\s+)?([A-Z][A-Za-z0-9/-]*(?:\s+[A-Za-z0-9/#-]+){0,2})/);
    if (m) machineName = m[1].replace(/[.,;]$/, '').trim();
  }

  const partsUsed = [];
  const partsNeeded = [];
  for (const re of PARTS_USED_RES) {
    for (const m of src.matchAll(re)) partsUsed.push(...splitPartList(m[1]));
  }
  for (const re of PARTS_NEEDED_RES) {
    for (const m of src.matchAll(re)) partsNeeded.push(...splitPartList(m[1]));
  }
  // A phrase can match both lists ("replaced X, need to order Y" is fine, but
  // "ordered a belt" shouldn't also count as used).
  const needed = new Set(partsNeeded.map((p) => p.toLowerCase()));
  const used = partsUsed.filter((p) => !needed.has(p.toLowerCase()));

  let statusHint = null;
  if (WAITING_RE.test(src)) statusHint = 'waiting_parts';
  else if (DONE_RE.test(src)) statusHint = 'completed';
  else statusHint = 'in_progress';

  return {
    machineName,
    orderNumber: extractOrderNumber(src),
    minutes: extractMinutes(src),
    partsUsed: [...new Set(used)],
    partsNeeded: [...new Set(partsNeeded)],
    statusHint,
    notes: src,
  };
}

module.exports = { parseEmail, parseNotes, extractOrderNumber, extractMinutes };
