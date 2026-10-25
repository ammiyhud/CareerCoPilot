export async function onRequest(context) {
    // 1. Verify this is a WebSocket request
    const upgradeHeader = context.request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // 2. Grab the API key we set up in Cloudflare earlier
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
        return new Response('API key missing from Cloudflare environment', { status: 500 });
    }

    // 3. The precise v1alpha endpoint required for Gemini Live Audio
    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    // 4. Create the two-way bridge (Frontend <--> Cloudflare <--> Google)
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    server.accept();

    try {
        const geminiSocket = new WebSocket(geminiUrl);

        // When Cloudflare connects to Google, start listening to your frontend
        geminiSocket.addEventListener('open', () => {
            server.addEventListener('message', (event) => {
                if (geminiSocket.readyState === WebSocket.OPEN) {
                    geminiSocket.send(event.data);
                }
            });
        });

        // When Google responds with audio/text, pipe it directly back to your frontend
        geminiSocket.addEventListener('message', (event) => {
            if (server.readyState === WebSocket.OPEN) {
                server.send(event.data);
            }
        });

        // If either side hangs up, close both connections cleanly
        geminiSocket.addEventListener('close', (event) => {
            server.close(event.code, event.reason);
        });
        server.addEventListener('close', (event) => {
            geminiSocket.close(event.code, event.reason);
        });

        geminiSocket.addEventListener('error', (error) => {
            server.close(1011, 'Gemini connection error');
        });

    } catch (err) {
        server.close(1011, 'Failed to establish Gemini connection');
    }

    // Send the handshake acceptance back to the browser
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
