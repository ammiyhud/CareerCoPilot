export async function onRequest(context) {
    const upgradeHeader = context.request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // Pulls your hidden key from Cloudflare's secure environment variables
    const GEMINI_API_KEY = context.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        return new Response('Missing Gemini API Key', { status: 500 });
    }

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    
    // Create a WebSocket bridge between the browser and Google
    const targetSocket = new WebSocket(url);
    const [client, server] = Object.values(new WebSocketPair());

    server.accept();

    // Relay messages from browser to Google
    server.addEventListener('message', event => {
        targetSocket.send(event.data);
    });

    // Relay messages from Google to browser
    targetSocket.addEventListener('message', event => {
        server.send(event.data);
    });

    // Handle closures
    server.addEventListener('close', event => {
        targetSocket.close(event.code, event.reason);
    });
    targetSocket.addEventListener('close', event => {
        server.close(event.code, event.reason);
    });

    return new Response(null, {
        status: 101,
        webSocket: client
    });
}
