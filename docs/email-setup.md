# Getting work-order emails into the dashboard automatically

The dashboard has one ingestion endpoint for email:

```
POST /api/ingest/email
Content-Type: application/json

{ "subject": "...", "body": "...", "from": "...", "receivedAt": "2026-07-11T09:30:00Z" }
```

The parser pulls the work order number (`WO#12345`, `Work Order 12345`, …),
machine (`Machine: CNC 3` or "CNC 3 is down" phrasing), priority, and
description out of the text and creates a work order. If it has seen the
order number before it does nothing, so it's safe to send the same email
twice.

There are three ways to feed it, easiest first.

## Option 1 — Paste the email (works today, zero setup)

Click **New work order → Paste email** in the dashboard and paste the subject
and body. Same parser, no infrastructure. Good for getting started and for
checking how well the parser reads your Plex emails before automating.

## Option 2 — Power Automate / Outlook rule → webhook (best for work email)

Most work email is Microsoft 365, and IT usually blocks IMAP but allows
Power Automate. Build a flow:

1. **Trigger:** "When a new email arrives (V3)" — filter to the address Plex
   sends from, or subject contains "Work Order".
2. **Action:** "HTTP" — `POST` to `http://YOUR-DASHBOARD-HOST:3000/api/ingest/email`
   with body:
   ```json
   {
     "subject": "@{triggerOutputs()?['body/subject']}",
     "body": "@{triggerOutputs()?['body/bodyPreview']}",
     "from": "@{triggerOutputs()?['body/from']}",
     "receivedAt": "@{triggerOutputs()?['body/receivedDateTime']}"
   }
   ```
   (Use the full `body` field instead of `bodyPreview` if your work orders
   run long; strip HTML with the "Html to text" action first.)

The dashboard machine needs to be reachable from the flow — on a work network
that usually means running it on a PC or small server with a fixed hostname.

**Set a token. This is required:** the tracker needs a sign-in for
everything, and the token is how an automated sender signs in. Start the server with
`INGEST_TOKEN=some-secret node server.js` and add an `X-Ingest-Token: some-secret`
header to the HTTP action.

## Option 3 — IMAP poller (if IMAP is available)

`scripts/email-poller.js` watches an inbox and forwards matching emails
itself. It is the only part of the project needing npm packages:

```bash
npm install imapflow mailparser
cp scripts/email-poller.config.example.json scripts/email-poller.config.json
# edit the config: host, user, password (use an app password), subjectFilter
node scripts/email-poller.js
```

It only touches messages whose subject matches `subjectFilter`, marks
ingested mail as read (that's how it avoids duplicates), and never deletes
or moves anything. Set `ingestToken` in the config to the same value as the
server's `INGEST_TOKEN`; without it the tracker refuses the email. Run it alongside the server, e.g. in a second terminal
or as a scheduled task.

## Tuning the parser to your Plex emails

Every plant's notification format is a little different. If the parser
misses fields, grab one real work-order email, and adjust the regexes in
`lib/parser.js` (`extractOrderNumber`, `extractLabeledMachine`,
`extractPriority`) to match your format — they're short and commented.
The **Paste email** tab is the quickest way to test changes.
