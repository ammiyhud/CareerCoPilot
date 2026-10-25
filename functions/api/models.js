// TEMPORARY helper: functions/api/models.js
// Visit /api/models once to see which models your Gemini key can use for live voice, then delete this file.
export async function onRequestGet({ env }) {
    const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY is missing' }, 500);

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY }
    });
    const out = await res.json();
    if (!res.ok) return json({ error: out.error?.message || 'Google API error', status: res.status }, res.status);

    const live = (out.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))
        .map(m => m.name);
    return json({ live_voice_models: live, note: 'Use one of these names as GEMINI_MODEL in index.html.' });
}
