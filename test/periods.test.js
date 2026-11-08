'use strict';
/** The Yesterday / This weekend / Last weekend boxes on Work Orders. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

test('date boxes: weekends are Fri–Sun; "this weekend" is current Fri–Sun, else the coming one', async () => {
  const { periodRanges } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'core.js')).href);
  const r = (today) => Object.fromEntries(periodRanges(today).map((p) => [p.id, `${p.from}..${p.to}`]));
  // Week of Nov 2–8, 2026: Mon 2 … Fri 6, Sat 7, Sun 8.
  const cases = {
    '2026-11-08': { yesterday: '2026-11-07..2026-11-07', thisweekend: '2026-11-06..2026-11-08', lastweekend: '2026-10-30..2026-11-01' }, // Sun
    '2026-11-07': { yesterday: '2026-11-06..2026-11-06', thisweekend: '2026-11-06..2026-11-08', lastweekend: '2026-10-30..2026-11-01' }, // Sat
    '2026-11-06': { yesterday: '2026-11-05..2026-11-05', thisweekend: '2026-11-06..2026-11-08', lastweekend: '2026-10-30..2026-11-01' }, // Fri
    '2026-11-05': { yesterday: '2026-11-04..2026-11-04', thisweekend: '2026-11-06..2026-11-08', lastweekend: '2026-10-30..2026-11-01' }, // Thu
    '2026-11-02': { yesterday: '2026-11-01..2026-11-01', thisweekend: '2026-11-06..2026-11-08', lastweekend: '2026-10-30..2026-11-01' }, // Mon
    '2026-11-09': { yesterday: '2026-11-08..2026-11-08', thisweekend: '2026-11-13..2026-11-15', lastweekend: '2026-11-06..2026-11-08' }, // next Mon
    '2027-01-01': { yesterday: '2026-12-31..2026-12-31', thisweekend: '2027-01-01..2027-01-03', lastweekend: '2026-12-25..2026-12-27' }, // Fri, year change
  };
  for (const [today, want] of Object.entries(cases)) assert.deepEqual(r(today), want, today);
});
