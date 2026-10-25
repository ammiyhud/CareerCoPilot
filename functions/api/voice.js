// Cloudflare Pages Function: functions/api/voice.js
// Bridges the browser's WebSocket to Gemini's Live API.

const MAX_SESSION_MS = 10 * 60 * 1000; // hard stop so a session can't run forever

// Close codes like 1005/1006 are reserved and throw if passed to close().
function safeCode(code) {
    if (!code || code < 1000 || code >= 5000) return 1000;
    return [1004, 1005, 1006, 1015].includes(code) ? 1000 : code;
}

// Gemini may send JSON as binary frames; the browser code expects text.
function toText(data) {
    return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.headers.get('Upgrade') !== 'websocket') {
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

    server.addEventListener('message', (e) => {
        try { gemini.send(e.data); } catch (_) {}
    });
    gemini.addEventListener('message', (e) => {
        try { server.send(toText(e.data)); } catch (_) {}
    });

    server.addEventListener('close', (e) => {
        try { gemini.close(safeCode(e.code), 'client closed'); } catch (_) {}
    });
    gemini.addEventListener('close', (e) => {
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
