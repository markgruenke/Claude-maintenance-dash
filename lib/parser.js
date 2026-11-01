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
//
// Notes usually come from speech now ("spent about an hour and a half on
// press two, replaced the drive belt, still need to order a guard"), so the
// patterns below expect spoken phrasing: number words, no punctuation, and
// lower-case machine names.

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "forty-five" -> "45", "two" -> "2" (for matching only; saved notes keep the original words). */
function wordsToDigits(text) {
  const unit = UNITS.join('|');
  return String(text)
    .replace(new RegExp(`\\b(${Object.keys(TENS).join('|')})[\\s-]+(${UNITS.slice(1, 10).join('|')})\\b`, 'gi'),
      (_, t, u) => String(TENS[t.toLowerCase()] + UNITS.indexOf(u.toLowerCase())))
    .replace(new RegExp(`\\b(${Object.keys(TENS).join('|')})\\b`, 'gi'), (t) => String(TENS[t.toLowerCase()]))
    .replace(new RegExp(`\\b(${unit})\\b`, 'gi'), (u) => String(UNITS.indexOf(u.toLowerCase())));
}

const H = '(?:h|hr|hrs|hour|hours)';
const M = '(?:m|min|mins|minute|minutes)';

/**
 * Time spent, in minutes, or null if none mentioned. Understands
 * "2h", "1.5 hrs", "2 hours 30 min", "45 minutes", "an hour", "half an hour",
 * "an hour and a half", "two and a half hours", "a couple hours",
 * "an hour and fifteen minutes".
 */
function extractMinutes(raw) {
  const text = wordsToDigits(raw).toLowerCase();
  let hours = null;
  let at = -1;
  const tryHours = (re, fn) => {
    if (hours !== null) return;
    const m = text.match(re);
    if (m) { hours = fn(m); at = m.index + m[0].length; }
  };
  tryHours(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+and\\s+(?:a\\s+)?half\\s+${H}\\b`), (m) => parseFloat(m[1]) + 0.5);
  tryHours(new RegExp(`\\b(?:an?|1)\\s+${H}\\s+and\\s+a\\s+half\\b`), () => 1.5);
  tryHours(new RegExp(`(\\d+)\\s+${H}\\s+and\\s+a\\s+half\\b`), (m) => parseFloat(m[1]) + 0.5);
  tryHours(new RegExp(`\\bhalf\\s+(?:an?\\s+)?${H}\\b`), () => 0.5);
  tryHours(new RegExp(`\\b(?:a\\s+)?couple(?:\\s+of)?\\s+${H}\\b`), () => 2);
  tryHours(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${H}\\b`), (m) => parseFloat(m[1]));
  tryHours(new RegExp(`\\b(?:an|a)\\s+${H}\\b`), () => 1);
  tryHours(/\b(?:quarter|1\/4)\s+(?:of\s+an\s+)?hour\b/, () => 0.25);

  const minRe = new RegExp(`(\\d+)\\s*${M}\\b`, 'g');
  let minutes = 0;
  for (const m of text.matchAll(minRe)) {
    // With an hours phrase, only count minutes said right after it
    // ("2 hours and 15 minutes"), not unrelated ones elsewhere.
    if (hours !== null && (m.index < at || m.index - at > 12)) continue;
    minutes = parseInt(m[1], 10);
    break;
  }
  if (hours === null && !minutes) return null;
  return Math.round((hours || 0) * 60) + minutes;
}

// First words that mean we grabbed a clause, not a part name.
const NOT_A_PART = new Set(('to it its it\'s then i i\'m we he she they everything also still now checked tested cleaned ' +
  'adjusted tightened ran reset cleared verified greased lubed started restarted put got went made did was is are ' +
  'will should back all that this there which so but when while after before because if as up out more some more ' +
  'look looked help him her them me you my our your about around roughly maybe probably took spent half ' +
  'like just pretty really also yeah okay ok um uh need needs needed waiting order ordering ordered gotta ' +
  'have has had going gonna got still should would could parts part').split(' '));
const TIME_WORDS = /\b(?:hours?|hrs?|minutes?|mins?|half|today|yesterday|tonight|morning|afternoon)\b/i;

/** Split "bearings and a drive belt", "seal, gasket and hose" into part names. */
function splitPartList(text) {
  return text
    .split(/,|\band\b|&|\+/i)
    .map((s) => {
      let t = s.trim().replace(/[.;!?]\s*$/, '');
      let prev;
      do { prev = t; t = t.replace(/^(?:a|an|the|some|new|couple of|few|a couple|another|more)\s+/i, ''); } while (t !== prev);
      // "two sprockets" -> "2 sprockets" (the server reads a leading number as the quantity)
      t = t.replace(/^([a-z]+)(?=\s)/i, (w) => wordsToDigits(w));
      return t.trim();
    })
    .filter((s) => s && s.length > 1 && !/^\d+$/.test(s)
      && !NOT_A_PART.has(s.split(/\s+/)[0].toLowerCase())
      && s.split(/\s+/).length <= 5
      && !TIME_WORDS.test(s));
}

// Where a list of parts ends: the end of a sentence, or the start of the next
// thing said ("…then", "…about an hour", "…parts needed…").
const STOP = '(?=\\s+(?:on|in|at|for|from|to|with|and then|then|but|so|because|which|that|it|it\'s|its|while|after|before|since|now|everything|this|today)\\b|,?\\s+parts?\\s+need|[.;!?\\n]|$)';
const PARTS_USED_RES = [
  new RegExp(`\\b(?:used|replaced|installed|swapped(?:\\s+(?:in|out))?|changed(?:\\s+out)?|put\\s+(?:in|on))\\s+(?:a\\s+|an\\s+|the\\s+|new\\s+|some\\s+)*([^.;!?\\n]+?)${STOP}`, 'gi'),
];

// Parts needed are only taken from what follows the words "parts needed"
// (or "part needed" / "needed parts"), so talking about something you
// "need to check" never creates a part by accident.
const SPOKEN_TIME = '(?:\\d+(?:\\.\\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|half|couple(?:\\s+of)?)\\s+(?:h|hr|hrs|hours?|m|min|mins|minutes?)\\b';
const NEEDED_STOP = `(?=\\s*,?\\s+(?:it\\s+took|took|about|around|roughly|spent|for\\s+about|then|and\\s+then|still|but|so|because|which|while|after|before|back\\s+up|running|working|it'?s|it\\s+is|everything|done|fixed|finished|waiting|parts?\\s+used|used|replaced|installed|swapped)\\b|\\s*,?\\s+${SPOKEN_TIME}|[.;!?\\n]|$)`;
const PARTS_NEEDED_RES = [
  new RegExp(`\\b(?:parts?\\s+need(?:ed|s)?|needed\\s+parts?)\\b\\s*(?:[:,-]\\s*|(?:are|is|include|includes|would\\s+be)\\s+)?(?:a\\s+|an\\s+|the\\s+|some\\s+|new\\s+)*([^.;!?\\n]+?)${NEEDED_STOP}`, 'gi'),
];

// Status. "Waiting on parts" is said outright, or follows from listing
// parts needed. "Need to order…" without a parts-needed list means the job
// isn't finished, but no part is added.
const WAITING_RE = /\b(?:waiting\s+(?:on|for)\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:part|parts|\w+\s+to\s+(?:come|arrive|ship))|on\s+order|parts?\s+(?:on\s+order|ordered))\b/i;
const NOT_DONE_RE = /\b(?:not\s+(?:fixed|done|finished|working|running|complete)|isn'?t\s+(?:fixed|done|finished|working|running)|still\s+(?:working|waiting|not|down|need|needs|have\s+to|got\s+to)|waiting\s+(?:on|for)|(?:need|have|gotta)\s+to\s+order|gotta\s+order|(?:come|coming|go|going)\s+back|didn'?t\s+(?:get|finish|have)|wasn'?t\s+able|couldn'?t|unfinished|in\s+progress|(?:pick|picking)\s+(?:it\s+)?up|next\s+shift|tomorrow)\b/i;
const DONE_RE = /\b(?:did\s+(?:the|a)\s+pm|pm\s+(?:is\s+)?done|fixed|repaired|resolved|back\s+up(?:\s+and\s+running)?|running\s+(?:again|good|fine|now)|working\s+(?:again|good|fine|now)|all\s+good|good\s+to\s+go|completed?|finished|took\s+care\s+of|squared\s+away|done)\b/i;

const EQUIPMENT = 'press|cnc|lathe|mill|welder|conveyor|robot|line|compressor|oven|saw|grinder|boiler|chiller|forklift|crane|hoist|dock door|door|cell|station|router|furnace|mixer|extruder|molder|wrapper|packer|bander|dryer|tower|booth|unit';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "CNC 3" -> /\bcnc\s*-?\s*3\b/i so "CNC3", "cnc-3" and "CNC 3" all match. */
function nameRegex(name) {
  // Letters, digits and symbols as separate pieces ("CNC3" -> CNC, 3). No
  // regex lookbehind here: older iPads' Safari can't parse it.
  const parts = (name.trim().match(/[a-z]+|\d+|[^\sa-z\d]+/gi) || []).map(escapeRe);
  return new RegExp('\\b' + parts.join('\\s*-?\\s*') + '\\b', 'i');
}

function titleCase(s) {
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bCnc\b/, 'CNC');
}

/**
 * Parse a free-form (often spoken) note. If knownMachines (array of names) is
 * given, those are checked first, which is far more reliable than patterns.
 *
 * @returns {{machineName, orderNumber, minutes, partsUsed, partsNeeded,
 *            statusHint, notes}}
 */
function parseNotes(text, knownMachines = []) {
  const src = String(text || '').trim();
  const norm = wordsToDigits(src); // "press two" -> "press 2" for matching

  // Known machine names beat guessing; longest first so "CNC 3" doesn't
  // steal a note about "CNC 31".
  let machineName = '';
  const sorted = [...knownMachines].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (nameRegex(name).test(norm) || nameRegex(name).test(src)) { machineName = name; break; }
  }
  if (!machineName) {
    const m = norm.match(new RegExp(`\\b((?:(?:${EQUIPMENT})\\s+)?(?:${EQUIPMENT}))\\s*(?:number\\s+|no\\.?\\s*|#\\s*)?(\\d+|[A-Z])\\b`, 'i'));
    if (m) machineName = titleCase(`${m[1]} ${m[2]}`.toLowerCase()).replace(/ ([a-z])$/i, (x) => x.toUpperCase());
  }
  if (!machineName) {
    const m = src.match(/\b(?:on|at)\s+(?:the\s+)?([A-Z][A-Za-z0-9/-]*(?:\s+[A-Z0-9][A-Za-z0-9/#-]*){0,2})/);
    if (m) machineName = m[1].replace(/[.,;]$/, '').trim();
  }

  const partsUsed = [];
  const partsNeeded = [];
  for (const re of PARTS_USED_RES) for (const m of src.matchAll(re)) partsUsed.push(...splitPartList(m[1]));
  for (const re of PARTS_NEEDED_RES) for (const m of src.matchAll(re)) partsNeeded.push(...splitPartList(m[1]));
  // "ordered a belt" shouldn't also count as used.
  const needed = new Set(partsNeeded.map((p) => p.toLowerCase()));
  const used = partsUsed.filter((p) => !needed.has(p.toLowerCase()));

  let statusHint;
  if (WAITING_RE.test(src)) statusHint = 'waiting_parts';
  else if (NOT_DONE_RE.test(src)) statusHint = partsNeeded.length ? 'waiting_parts' : 'in_progress';
  else if (DONE_RE.test(src)) statusHint = 'completed';
  else if (partsNeeded.length) statusHint = 'waiting_parts';
  else statusHint = null; // nothing said either way: the server decides (see commitWork)

  return {
    machineName,
    orderNumber: extractOrderNumber(norm),
    minutes: extractMinutes(src),
    partsUsed: [...new Set(used)],
    partsNeeded: [...new Set(partsNeeded)],
    statusHint,
    notes: src,
  };
}

module.exports = { parseEmail, parseNotes, extractOrderNumber, extractMinutes, wordsToDigits };
