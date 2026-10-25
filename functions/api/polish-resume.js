// Cloudflare Pages Function: functions/api/polish-resume.js
export async function onRequestPost({ request, env }) {
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    try {
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is missing' }, 500);
        const { resume, job } = await request.json();
        if (!resume) return json({ error: 'No resume data received' }, 400);

        const prompt = `You are an expert resume writer. Write a professional summary of 2 to 3 sentences for the candidate below.
Use ONLY facts found in the resume data. Do not invent employers, tools, numbers, or achievements. Do not mention work hours or schedule.
${job ? 'Tailor the wording to this target job: ' + JSON.stringify(job) : 'No target job was provided.'}
Resume data: ${JSON.stringify(resume)}
Output ONLY the summary text, with no quotation marks or extra commentary.`;

        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
        });
        const out = await res.json();
        if (!res.ok) return json({ error: out.error?.message || 'Anthropic API error' }, res.status);
        return json({ summary: (out.content?.[0]?.text || '').trim() });
    } catch (err) {
        return json({ error: err.message }, 500);
    }
}
