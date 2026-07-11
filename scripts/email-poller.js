'use strict';
/**
 * Optional IMAP email poller — watches a mailbox for Plex work-order emails
 * and posts each new one to the dashboard's /api/ingest/email endpoint.
 *
 * This is the ONE part of the project with external dependencies, because
 * talking IMAP from scratch isn't worth it. To use it:
 *
 *   npm install imapflow mailparser
 *   cp scripts/email-poller.config.example.json scripts/email-poller.config.json
 *   (fill in your mail server details)
 *   node scripts/email-poller.js
 *
 * It polls the inbox on an interval, only ingests messages that match the
 * subject filter, and marks processed messages with the \Seen flag so they
 * are never ingested twice. Nothing is deleted or moved.
 *
 * If your work email is Outlook/Microsoft 365 and IMAP is blocked by IT,
 * use the webhook route instead — see docs/email-setup.md for a Power
 * Automate flow that forwards new emails to /api/ingest/email directly.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'email-poller.config.json');

let ImapFlow, simpleParser;
try {
  ({ ImapFlow } = require('imapflow'));
  ({ simpleParser } = require('mailparser'));
} catch {
  console.error('Missing dependencies. Run:  npm install imapflow mailparser');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  console.error(`No config found. Copy scripts/email-poller.config.example.json to
${CONFIG_FILE} and fill in your mail settings.`);
  process.exit(1);
}

const {
  host, port = 993, secure = true, user, password,
  mailbox = 'INBOX',
  subjectFilter = 'work order',   // only ingest emails whose subject contains this (case-insensitive); '' = everything
  dashboardUrl = 'http://localhost:3000',
  ingestToken = '',
  pollSeconds = 120,
} = config;

async function postToDashboard(email) {
  const res = await fetch(dashboardUrl.replace(/\/$/, '') + '/api/ingest/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ingestToken ? { 'X-Ingest-Token': ingestToken } : {}),
    },
    body: JSON.stringify(email),
  });
  if (!res.ok) throw new Error(`dashboard responded ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pollOnce() {
  const client = new ImapFlow({ host, port, secure, auth: { user, pass: password }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      // Unseen messages only; \Seen is our "already ingested" marker.
      const uids = await client.search({ seen: false });
      for (const uid of uids || []) {
        const msg = await client.fetchOne(uid, { source: true });
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject || '';
        if (subjectFilter && !subject.toLowerCase().includes(subjectFilter.toLowerCase())) {
          continue; // leave unrelated mail untouched (and unseen)
        }
        const out = await postToDashboard({
          subject,
          body: parsed.text || '',
          from: parsed.from ? parsed.from.text : '',
          receivedAt: parsed.date ? parsed.date.toISOString() : undefined,
        });
        await client.messageFlagsAdd(uid, ['\\Seen']);
        console.log(`[${new Date().toLocaleTimeString()}] ingested "${subject}" -> ` +
          (out.created ? `created order ${out.workOrder.orderNumber || out.workOrder.id}` : 'matched existing order'));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function main() {
  console.log(`Polling ${user}@${host}/${mailbox} every ${pollSeconds}s; forwarding to ${dashboardUrl}`);
  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('poll failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  }
}

main();
