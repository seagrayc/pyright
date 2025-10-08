import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import express from "express";
import path from "path";
import { createServer } from "./mcpServer";

const app = express();
app.use(cors({ origin: "*", methods: "GET,POST", preflightContinue: false, optionsSuccessStatus: 204 }));

const transports: Map<string, SSEServerTransport> = new Map<string, SSEServerTransport>();
const clientToSession: Map<string, string> = new Map<string, string>();

// Serve static UI built by Vite (packages/pyright/dist-web)
const staticDir = path.resolve(__dirname, "../dist-web");
app.use(express.static(staticDir));
app.get("/", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
});

app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/message", res);
    const server = createServer();

    await server.connect(transport);
    console.log(`MCP SSE client connected: ${transport.sessionId}`);
    transports.set(transport.sessionId, transport);

    const clientId = (req?.query?.clientId as string) ?? "";
    if (clientId) {
        clientToSession.set(clientId, transport.sessionId);
    }

    server.onclose = async () => {
        transports.delete(transport.sessionId);
        console.log(`MCP SSE client disconnected: ${transport.sessionId}`);
        if (clientId) {
            clientToSession.delete(clientId);
        }
    };
});

app.get("/session", (req, res) => {
    const clientId = (req?.query?.clientId as string) ?? "";
    const sessionId = clientToSession.get(clientId);
    if (!sessionId) {
        res.status(404).json({ error: `unknown clientId ${clientId}` });
        return;
    }
    res.json({ sessionId });
});

app.post("/message", async (req, res) => {
    const headerSession = (req.headers["x-session-id"] as string) ?? "";
    const querySession = (req?.query?.sessionId as string) ?? "";
    const sessionId = headerSession || querySession;
    const transport = transports.get(sessionId);
    if (!transport) {
        res.status(404).json({ error: `unknown sessionId ${sessionId}` });
        return;
    }
    console.log(`POST /message for session ${sessionId}`);
    await transport.handlePostMessage(req, res);
});

const PORT = Number(process.env.PORT ?? 3333);
app.listen(PORT, () => {
    console.log(`Pyright MCP Server (SSE) listening on http://127.0.0.1:${PORT}`);
    console.log(`Connect SSE at http://127.0.0.1:${PORT}/sse and POST messages to /message?sessionId=...`);
});


