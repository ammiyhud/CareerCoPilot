// TEMPORARY helper: functions/api/live-test.js
// Opens a Gemini Live session from the server, sends a setup message, and reports what Google sends back.
// Try: /api/live-test   or   /api/live-test?model=models/gemini-2.5-flash-native-audio-preview-12-2025
// Add &modalities=0 to leave out the response-modalities setting. Delete this file when finished.
export async function onRequestGet({ request, env }) {
    const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY is missing' }, 500);

    const q = new URL(request.url).searchParams;
    const model = q.get('model') || 'models/gemini-2.5-flash-native-audio-latest';
    const setup = { model };
    if (q.get('modalities') !== '0') setup.generationConfig = { responseModalities: ['AUDIO'] };

    const started = Date.now();
    const events = [];
    const up = await fetch(
        'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + env.GEMINI_API_KEY,
        { headers: { Upgrade: 'websocket' } }
    );
    if (!up.webSocket) {
        return json({ model, step: 'connect', http_status: up.status, body: (await up.text()).slice(0, 500) }, 502);
    }
    const ws = up.webSocket;
    ws.accept();

    const text = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));
    await new Promise((resolve) => {
        ws.addEventListener('message', (e) => {
            events.push({ ms: Date.now() - started, message: text(e.data).slice(0, 300) });
        });
        ws.addEventListener('close', (e) => {
            events.push({ ms: Date.now() - started, closed: { code: e.code, reason: e.reason } });
            resolve();
        });
        ws.addEventListener('error', () => {
            events.push({ ms: Date.now() - started, error: 'socket error' });
            resolve();
        });
        ws.send(JSON.stringify({ setup }));
        setTimeout(resolve, 7000);
    });
    try { ws.close(1000, 'test done'); } catch (_) {}

    return json({ sent_setup: setup, waited_ms: Date.now() - started, events: events.length ? events : 'Google sent nothing in 7 seconds' });
}
