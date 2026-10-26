// Cloudflare Pages Function: functions/api/voice.js
// Bridges the browser's WebSocket to Gemini's Live API.

const MAX_SESSION_MS = 10 * 60 * 1000; // hard stop so a session can't run forever

// Close codes like 1005/1006 are reserved and throw if passed to close().
function safeCode(code) {
    if (!code || code < 1000 || code >= 5000) return 1000;
    return [1004, 1005, 1006, 1015].includes(code) ? 1000 : code;
}

// Gemini may send JSON as binary frames; the browser code expects text.
async function toText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    if (data && typeof data.text === 'function') return await data.text(); // Blob
    return String(data);
}

// Temporary diagnostic: /api/voice?test=1[&via=fetch|header|ctor][&model=...]
async function runLiveTest(request, env) {
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY is missing' }, 500);

    const key = env.GEMINI_API_KEY;
    const clean = (s) => String(s).split(key).join('***').slice(0, 300);
    const q = new URL(request.url).searchParams;
    const via = q.get('via') || 'fetch';
    const model = q.get('model') || 'models/gemini-2.5-flash-native-audio-latest';
    const setup = { model, generationConfig: { responseModalities: ['AUDIO'] } };
    const base = 'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

    const started = Date.now();
    const events = [];
    const mark = (o) => events.push({ ms: Date.now() - started, ...o });

    let ws;
    try {
        if (via === 'ctor') {
            ws = new WebSocket(base.replace('https://', 'wss://') + '?key=' + key);
        } else {
            const up = await fetch(via === 'header' ? base : base + '?key=' + key, {
                headers: via === 'header' ? { Upgrade: 'websocket', 'x-goog-api-key': key } : { Upgrade: 'websocket' }
            });
            mark({ http_status: up.status });
            if (!up.webSocket) {
                mark({ body: clean(await up.text()) });
                return json({ via, events });
            }
            ws = up.webSocket;
            ws.accept();
        }
    } catch (e) {
        mark({ exception: clean(e.message || e) });
        return json({ via, events });
    }

    await new Promise((resolve) => {
        ws.addEventListener('message', async (e) => mark({ message: clean(await toText(e.data)) }));
        ws.addEventListener('close', (e) => { mark({ closed: { code: e.code, reason: clean(e.reason || '') } }); resolve(); });
        ws.addEventListener('error', (e) => { mark({ error: clean(e.message || 'socket error') }); resolve(); });
        const send = () => {
            try { ws.send(JSON.stringify({ setup })); mark({ sent_setup: true }); }
            catch (e) { mark({ send_failed: clean(e.message || e) }); resolve(); }
        };
        if (via === 'ctor') ws.addEventListener('open', () => { mark({ opened: true }); send(); });
        else send();
        setTimeout(resolve, 7000);
    });
    try { ws.close(1000, 'test done'); } catch (_) {}
    return json({ via, events });
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.headers.get('Upgrade') !== 'websocket') {
        if (new URL(request.url).searchParams.has('test')) return runLiveTest(request, env);
        return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // Only accept connections from your own site (stops casual abuse of your key).
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== new URL(request.url).host) {
        return new Response('Forbidden', { status: 403 });
    }

    if (!env.GEMINI_API_KEY) {
        return new Response('Server is not configured', { status: 500 });
    }

    // Open the upstream socket the documented Workers way: fetch with Upgrade.
    const upstream = await fetch(
        'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' +
            env.GEMINI_API_KEY,
        { headers: { Upgrade: 'websocket' } }
    );
    const gemini = upstream.webSocket;
    if (!gemini) {
        return new Response('Could not reach Gemini', { status: 502 });
    }
    gemini.accept(); // already open, so no message queue is needed

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const note = (t) => { try { server.send(JSON.stringify({ debug: t })); } catch (_) {} };
    let fromClient = 0, fromGoogle = 0;
    note('Proxy connected to Google.');

    server.addEventListener('message', (e) => {
        if (fromClient++ === 0) note('Proxy got your setup message and sent it to Google.');
        try { gemini.send(e.data); } catch (_) {}
    });
    let chain = Promise.resolve(); // keeps Google's messages in order
    gemini.addEventListener('message', (e) => {
        fromGoogle++;
        chain = chain.then(async () => {
            try { server.send(await toText(e.data)); } catch (_) {}
        });
    });
    setTimeout(() => {
        if (fromGoogle === 0) note(`Google has sent nothing back after 6 seconds (messages from you: ${fromClient}).`);
    }, 6000);

    server.addEventListener('close', (e) => {
        try { gemini.close(safeCode(e.code), 'client closed'); } catch (_) {}
    });
    gemini.addEventListener('close', (e) => {
        console.log('Gemini closed', e.code, e.reason);
        try {
            server.send(JSON.stringify({ error: { message: `Gemini closed the session (${e.code}): ${e.reason || 'no reason given'}` } }));
        } catch (_) {}
        try { server.close(safeCode(e.code), String(e.reason || 'upstream closed').slice(0, 120)); } catch (_) {}
    });
    gemini.addEventListener('error', () => {
        try { server.close(1011, 'Gemini connection error'); } catch (_) {}
    });

    setTimeout(() => {
        try { server.close(1000, 'Session time limit'); } catch (_) {}
        try { gemini.close(1000, 'Session time limit'); } catch (_) {}
    }, MAX_SESSION_MS);

    return new Response(null, { status: 101, webSocket: client });
}
