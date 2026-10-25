export async function onRequest(context) {
    // 1. Verify WebSocket upgrade
    const upgradeHeader = context.request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // 2. Fetch Google API key
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
        return new Response('API key missing from Cloudflare environment', { status: 500 });
    }

    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    // 3. Create the WebSocket bridge
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    server.accept();

    try {
        const geminiSocket = new WebSocket(geminiUrl);
        let isGeminiReady = false;
        let messageQueue = []; // The waiting room for early payloads

        // When Google answers, flush any waiting messages (like the setup envelope)
        geminiSocket.addEventListener('open', () => {
            isGeminiReady = true;
            while (messageQueue.length > 0) {
                geminiSocket.send(messageQueue.shift());
            }
        });

        // Listen to your frontend mic. If Google isn't ready, put the data in the waiting room.
        server.addEventListener('message', (event) => {
            if (isGeminiReady && geminiSocket.readyState === WebSocket.OPEN) {
                geminiSocket.send(event.data);
            } else {
                messageQueue.push(event.data);
            }
        });

        // Pipe Google's AI audio responses back to your frontend
        geminiSocket.addEventListener('message', (event) => {
            if (server.readyState === WebSocket.OPEN) {
                server.send(event.data);
            }
        });

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

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
