// Cloudflare Pages Function: functions/api/apply-kit.js
// Turns the candidate's polished resume + one job into the text an application needs.
//
// POST /api/apply-kit
//   {"resume":{...}, "job":{"title":"","company":"","location":"","requirements":[],"summary":""}, "rules":{"roles":"","salary":"","arrangement":"","availability":""}}
//   -> {"kit":{"cover_letter":"","email_subject":"","email_body":"","keywords":[""],"gaps":[""]}}
//
// Nothing is sent from here: the kit is returned to the browser so the candidate reviews it
// and sends it from their own mailbox.

const VERSION = 'apply-kit v1';
const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 1600;

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function resumeDigest(resume) {
    if (!resume || typeof resume !== 'object') return '(no resume data)';
    const jobs = (resume.experience || []).map((j) => ({
        role: clean(j.role),
        company: clean(j.company),
        location: clean(j.location),
        dates: clean(j.dates),
        bullets: (j.bullets || []).map(clean).filter(Boolean).slice(0, 6)
    }));
    return JSON.stringify({
        name: clean(resume.name),
        title: clean(resume.title),
        contact: clean(resume.contact),
        summary: clean(resume.summary),
        experience: jobs,
        skills: (resume.skills || []).map(clean).filter(Boolean),
        education: (resume.education || []).map(clean).filter(Boolean)
    });
}

function jobDigest(job) {
    if (!job || typeof job !== 'object') return '(no job data)';
    return JSON.stringify({
        title: clean(job.title || job.role),
        company: clean(job.company),
        location: clean(job.location),
        summary: clean(job.summary),
        requirements: (job.requirements || []).map(clean).filter(Boolean).slice(0, 20)
    });
}

const rulesDigest = (rules = {}) => JSON.stringify({
    target_roles: clean(rules.roles),
    minimum_salary: clean(rules.salary),
    work_arrangement: clean(rules.arrangement),
    schedule_availability: clean(rules.availability)
});

export async function onRequestPost({ request, env }) {
    try {
        if (!env.ANTHROPIC_API_KEY) {
            return json({ error: 'ANTHROPIC_API_KEY is missing from this Pages project.' }, 500);
        }

        const raw = await request.text();
        if (!raw) return json({ error: `${VERSION}: the browser sent an empty request body.` }, 400);
        let body;
        try { body = JSON.parse(raw); } catch (err) {
            return json({ error: `${VERSION}: the request body was not valid JSON (${raw.length} bytes, ${err.message}).` }, 400);
        }

        const resume = body.resume;
        const job = body.job;
        if (!resume || (!resume.experience?.length && !resume.summary)) {
            return json({ error: 'The resume is still empty. Upload it or run the interview first.' }, 400);
        }
        if (!job || (!job.title && !job.role && !job.company)) {
            return json({ error: 'Send the job this kit is for.' }, 400);
        }

        const prompt = `You write job applications for one candidate. Use ONLY facts in the resume data below.
Never invent employers, dates, degrees, tools or numbers. Do not mention work hours, salary or availability
unless the job text asks for them, and never claim experience the resume does not show.

Write:
1. cover_letter: at most 220 words, plain text, no markdown, addressed to the hiring team, opening with the
   strongest overlap between the resume and this job, one short paragraph on evidence, and a closing line.
2. email_subject: under 90 characters, naming the role and the candidate.
3. email_body: at most 150 words, plain text, the email this cover letter would be attached to. Sign with the
   candidate's name. Do not invent an address or phone number.
4. keywords: up to 10 requirements from the job that the resume genuinely evidences.
5. gaps: up to 5 requirements the resume does NOT evidence, phrased as short questions the candidate could answer.

Reply with ONLY JSON in exactly this shape:
{"cover_letter":"","email_subject":"","email_body":"","keywords":[""],"gaps":[""]}

CANDIDATE RULES: ${rulesDigest(body.rules)}
RESUME: ${resumeDigest(resume)}
JOB: ${jobDigest(job)}`;

        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model: env.ANTHROPIC_MODEL || MODEL,
                max_tokens: MAX_TOKENS,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const reply = await res.text();
        let out = null;
        try { out = reply ? JSON.parse(reply) : null; } catch (_) { /* reported below */ }
        if (!res.ok) {
            return json({ error: `Claude API refused the request (HTTP ${res.status}): ${out?.error?.message || reply.slice(0, 200) || '(empty reply)'}` }, 502);
        }
        if (!out) {
            return json({ error: `Claude API returned an empty or non-JSON reply (HTTP ${res.status}, ${reply.length} bytes).` }, 502);
        }

        const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0) {
            return json({ error: `Claude did not return application text (stop reason: ${out.stop_reason}). It said: ${text.slice(0, 200) || '(nothing)'}` }, 502);
        }
        if (end <= start) {
            return json({ error: `Claude's answer was cut off before the JSON was complete (stop reason: ${out.stop_reason}). Try again.` }, 502);
        }

        let kit;
        try { kit = JSON.parse(text.slice(start, end + 1)); } catch (_) {
            return json({ error: `Claude's answer was malformed (stop reason: ${out.stop_reason}).` }, 502);
        }

        return json({
            kit: {
                cover_letter: clean(kit.cover_letter),
                email_subject: clean(kit.email_subject),
                email_body: String(kit.email_body || '').trim(),
                keywords: Array.isArray(kit.keywords) ? kit.keywords.slice(0, 10).map(clean).filter(Boolean) : [],
                gaps: Array.isArray(kit.gaps) ? kit.gaps.slice(0, 5).map(clean).filter(Boolean) : []
            }
        });
    } catch (err) {
        return json({ error: `${VERSION}: ${err.message}` }, 500);
    }
}

export async function onRequestGet() {
    return new Response(`${VERSION} is live`, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}
