export async function onRequest(context) {
    // Only allow POST requests
    if (context.request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    try {
        // Grab the Anthropic API key from Cloudflare settings
        const apiKey = context.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'Anthropic API key missing from Cloudflare environment' }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Parse the job details sent from your index.html frontend
        const data = await context.request.json();
        const { jobRole, schedule, workArrangement } = data;

        // Construct the prompt for Claude
        const prompt = `You are an expert executive resume writer. The user is a Paratransit Dispatcher and Operations Supervisor applying for a ${jobRole || 'transit'} role. 
        They require a ${workArrangement || 'hybrid'} work arrangement and are available ${schedule || 'standard hours'}.
        Write a highly impactful, ATS-friendly professional summary tailored to this criteria.
        Keep it under 3 sentences. Output ONLY the new summary text, no conversational filler or quotation marks.`;

        // Call the Anthropic API with the upgraded model
        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 200,
                messages: [
                    { role: 'user', content: prompt }
                ]
            })
        });

        const result = await anthropicResponse.json();

        // Handle Anthropic API errors
        if (!anthropicResponse.ok) {
            return new Response(JSON.stringify({ error: 'Anthropic API Error', details: result }), { 
                status: anthropicResponse.status,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Extract the generated text and send it back to the frontend canvas
        const polishedSummary = result.content[0].text;
        
        return new Response(JSON.stringify({ summary: polishedSummary }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
