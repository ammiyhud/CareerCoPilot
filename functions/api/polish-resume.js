export async function onRequestPost(context) {
	try {
		const { rawNotes, targetRole, industry } = await context.request.json();
		const apiKey = context.env.ANTHROPIC_API_KEY;

		if (!apiKey) {
			return new Response(JSON.stringify({ error: "Missing ANTHROPIC_API_KEY secret." }), {
				status: 500,
				headers: { "Content-Type": "application/json" }
			});
		}

		const systemPrompt = `You are an elite executive resume writer and ATS specialist.
Transform the candidate's raw conversational notes into a structured, high-impact resume.
Rules:
1. Format all work experience bullets using the STAR methodology (Situation, Task, Action, Result) with quantified metrics.
2. Eliminate all cliché corporate filler phrases. Write in active, punchy past tense.
3. Return ONLY a valid JSON object matching the requested schema with no surrounding Markdown fences.`;

		const userPrompt = `Target Role: ${targetRole || 'Not specified'}
Target Industry: ${industry || 'Not specified'}
Raw Interview Transcript and Extracted Notes:
${JSON.stringify(rawNotes, null, 2)}

Produce a JSON response with keys:
- fullName
- title
- contact: { email, phone, location, linkedin }
- summary
- skills: array of strings
- experience: array of objects [{ company, role, dates, location, accomplishments: [bullets] }]
- education: array of objects [{ institution, degree, year }]
- certifications: array of strings`;

		const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json"
			},
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 2500,
				temperature: 0.2,
				system: systemPrompt,
				messages: [{ role: "user", content: userPrompt }]
			})
		});

		const data = await anthropicResponse.json();
		const polishedText = data.content?.[0]?.text || "{}";
		const cleanJson = polishedText.replace(/```json/g, "").replace(/```/g, "").trim();
		const parsedData = JSON.parse(cleanJson);

		return new Response(JSON.stringify({ success: true, resume: parsedData }), {
			headers: { "Content-Type": "application/json" }
		});
	} catch (err) {
		return new Response(JSON.stringify({ error: err.message }), {
			status: 500,
			headers: { "Content-Type": "application/json" }
		});
	}
}
