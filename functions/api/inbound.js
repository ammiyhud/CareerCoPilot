// Cloudflare Pages Function: functions/api/inbound.js
// Receives forwarded job-related email from an inbound-email provider (Postmark inbound, or any
// service that POSTs JSON) and stores it under the recipient's private mailbox token.
//
// No Google account, no OAuth, no password: the only credential is the address the message was
// sent to, e.g. provider-hash+a1b2c3d4e5f6g7h8@inbound.example.com — the part after "+".
//
// Setup (Postmark → your Inbound Message Stream → Settings → Webhook):
//   URL: https://<your-site>/api/inbound?key=<INBOUND_SECRET>
// Env needed: INBOUND_SECRET (shared secret), MAIL_DB (D1 binding). ANTHROPIC_API_KEY is not used here.

const VERSION = 'inbound v1';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_STORED_CHARS = 20000;
const MAX_SUBJECT_CHARS = 300;
const MAX_PER_MAILBOX = 200;
const TOKEN_RE = /^[a-z0-9]{16,40}$/;

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

// Constant-time-ish compare so a wrong key can't be narrowed down by timing.
function safeEqual(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (!x || !y || x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

// Accepts the secret as ?key=, ?token=, x-inbound-key, Bearer, or the password of Basic auth.
function presentedSecret(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const auth = request.headers.get('Authorization') || '';
    const basic = auth.toLowerCase().startsWith('basic ')
        ? (() => { try { return atob(auth.slice(6).trim()); } catch (_) { return ''; } })()
        : '';
    return q.get('key') || q.get('token') || request.headers.get('x-inbound-key') ||
        (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '') ||
        (basic.includes(':') ? basic.slice(basic.indexOf(':') + 1) : '');
}

function htmlToText(html) {
    return String(html || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// The mailbox token is the plus-address suffix in the recipient, e.g. hash+a1b2...@inbound.example.com
function tokenFromAddress(address) {
    const addr = String(address || '').trim().toLowerCase();
    const at = addr.lastIndexOf('@');
    if (at < 0) return '';
    const local = addr.slice(0, at);
    const plus = local.lastIndexOf('+');
    const candidate = plus >= 0 ? local.slice(plus + 1) : '';
    return TOKEN_RE.test(candidate) ? candidate : '';
}

// Postmark puts the plus-address hash in MailboxHash; other providers differ, so try the obvious paths.
function resolveToken(body) {
    const direct = String(body.MailboxHash || body.mailbox_hash || body.token || '').trim().toLowerCase();
    if (TOKEN_RE.test(direct)) return direct;

    const lists = [body.ToFull, body.toFull, body.recipients, body.To, body.to, body.recipient, body.OriginalRecipient];
    for (const entry of lists) {
        const items = Array.isArray(entry) ? entry : [entry];
        for (const item of items) {
            if (!item) continue;
            if (typeof item === 'object') {
                const hash = String(item.MailboxHash || item.mailbox_hash || '').trim().toLowerCase();
                if (TOKEN_RE.test(hash)) return hash;
                const found = tokenFromAddress(item.Email || item.email || item.address);
                if (found) return found;
            } else {
                const found = tokenFromAddress(item);
                if (found) return found;
            }
        }
    }
    return '';
}

// Normalises Postmark's shape and a plain {to,from,subject,text} shape into one record.
function readMessage(body) {
    const fromFull = body.FromFull || body.fromFull || {};
    const from = String(fromFull.Email || body.From || body.from || body.sender || '').slice(0, 320);
    const fromName = String(fromFull.Name || body.FromName || body.fromName || '').slice(0, 160);
    const subject = String(body.Subject || body.subject || '(no subject)').slice(0, MAX_SUBJECT_CHARS);
    const text = String(body.TextBody || body.text || body.plain || body.StrippedTextReply || '');
    const bodyText = (text || htmlToText(body.HtmlBody || body.html)).slice(0, MAX_STORED_CHARS);
    const rawDate = body.Date || body.date || '';
    const parsed = rawDate ? Date.parse(rawDate) : NaN;
    const id = String(body.MessageID || body.message_id || body.MessageId || body.id || '').slice(0, 200);
    return {
        id,
        from,
        from_name: fromName,
        subject,
        body: bodyText,
        snippet: bodyText.replace(/\s+/g, ' ').slice(0, 400),
        received_at: Number.isFinite(parsed) ? parsed : Date.now()
    };
}

// A message with no provider id still needs a stable key so retries don't create duplicates.
async function fallbackId(msg) {
    const data = new TextEncoder().encode(`${msg.from}|${msg.subject}|${msg.received_at}|${msg.body.slice(0, 200)}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureSchema(db) {
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS mail (
            token TEXT NOT NULL,
            id TEXT NOT NULL,
            received_at INTEGER NOT NULL,
            from_addr TEXT NOT NULL DEFAULT '',
            from_name TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            snippet TEXT NOT NULL DEFAULT '',
            kind TEXT,
            summary TEXT NOT NULL DEFAULT '',
            needs_reply INTEGER NOT NULL DEFAULT 0,
            reply_intent TEXT NOT NULL DEFAULT '',
            draft_subject TEXT NOT NULL DEFAULT '',
            draft_body TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (token, id)
        )`
    ).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS mail_by_token_time ON mail (token, received_at DESC)').run();
}

async function store(env, token, msg) {
    const db = env.MAIL_DB;
    await ensureSchema(db);
    const id = msg.id || (await fallbackId(msg));
    const result = await db.prepare(
        `INSERT OR IGNORE INTO mail (token, id, received_at, from_addr, from_name, subject, body, snippet)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(token, id, msg.received_at, msg.from, msg.from_name, msg.subject, msg.body, msg.snippet).run();

    // Keep each mailbox bounded so one forwarding loop can't grow unbounded.
    await db.prepare(
        `DELETE FROM mail WHERE token = ?1 AND id NOT IN (
            SELECT id FROM mail WHERE token = ?1 ORDER BY received_at DESC LIMIT ?2
         )`
    ).bind(token, MAX_PER_MAILBOX).run();

    return { id, duplicate: !(result.meta?.changes ?? 0) };
}

export async function onRequestGet({ env }) {
    return json({
        version: VERSION,
        ready: Boolean(env.INBOUND_SECRET && env.MAIL_DB),
        needs: [
            !env.INBOUND_SECRET && 'INBOUND_SECRET',
            !env.MAIL_DB && 'MAIL_DB (D1 binding)'
        ].filter(Boolean),
        note: 'Point your inbound-email webhook at POST /api/inbound?key=<INBOUND_SECRET>.'
    });
}

export async function onRequestPost({ request, env }) {
    try {
        if (!env.INBOUND_SECRET) {
            return json({ error: 'INBOUND_SECRET is not set. Add it before pointing a webhook here.' }, 503);
        }
        if (!safeEqual(presentedSecret(request), env.INBOUND_SECRET)) {
            // 403 tells Postmark to stop retrying, which is what we want for a bad key.
            return json({ error: 'Bad or missing webhook key.' }, 403);
        }
        if (!env.MAIL_DB) {
            // 503 on purpose: the provider retries, so mail sent during setup isn't lost.
            return json({ error: 'MAIL_DB binding is missing, so incoming mail cannot be stored yet.' }, 503);
        }

        const declared = Number(request.headers.get('Content-Length') || 0);
        if (declared > MAX_BODY_BYTES) return json({ error: 'Message too large.' }, 413);

        const raw = await request.text();
        if (!raw) return json({ error: 'Empty body.' }, 400);
        if (raw.length > MAX_BODY_BYTES) return json({ error: 'Message too large.' }, 413);

        let body;
        try {
            body = JSON.parse(raw);
        } catch (_) {
            // Non-JSON providers (form posts) are rejected clearly rather than stored as garbage.
            return json({ error: 'Send JSON: Postmark inbound, or {to,from,subject,text}.' }, 415);
        }
        if (!body || typeof body !== 'object') return json({ error: 'Body must be a JSON object.' }, 400);

        const token = resolveToken(body);
        if (!token) {
            // 200 so the provider doesn't retry forever: nothing here can claim this message.
            return json({ ok: true, stored: false, ignored: 'No mailbox token in the recipient address.' });
        }

        const msg = readMessage(body);
        const saved = await store(env, token, msg);
        return json({ ok: true, stored: !saved.duplicate, duplicate: saved.duplicate, id: saved.id });
    } catch (err) {
        return json({ error: `${VERSION}: ${err.message}` }, 500);
    }
}
