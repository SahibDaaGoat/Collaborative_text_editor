import { createServer, IncomingMessage } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createReplica, RgaReplica, type Operation, type VectorClock } from "@collab/crdt";
import { clientMessageSchema, operationSchema, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@collab/protocol";
import { Database, type DocumentRecord, type StoredOperation } from "@collab/database";

type User = { ws: WebSocket; clientId: string; displayName: string; cursor: number | null };
type Room = { replica: RgaReplica; users: Map<WebSocket, User> };
type Store = {
  createDocument(title?: string): Promise<DocumentRecord>;
  authorize(documentId: string, token: string): Promise<boolean>;
  getOperations(documentId: string, knownClock: VectorClock): Promise<StoredOperation[]>;
  appendOperation(documentId: string, operation: Operation): Promise<{ logSequence: number; inserted: boolean }>;
  close(): Promise<void>;
};

type MemoryDocument = DocumentRecord & { operations: Array<{ logSequence: number; operation: Operation }> };
class MemoryStore implements Store {
  private readonly documents = new Map<string, MemoryDocument>();
  private sequence = 0;
  async createDocument(title = "Untitled document"): Promise<DocumentRecord> { const id = randomUUID(); const token = randomBytes(32).toString("base64url"); const doc = { id, token, title, operations: [] }; this.documents.set(id, doc); return { id, token, title }; }
  async authorize(documentId: string, token: string): Promise<boolean> { return this.documents.get(documentId)?.token === token; }
  async getOperations(documentId: string, knownClock: VectorClock): Promise<StoredOperation[]> { return (this.documents.get(documentId)?.operations ?? []).filter(item => (knownClock[item.operation.actorId] ?? 0) < item.operation.seq); }
  async appendOperation(documentId: string, operation: Operation): Promise<{ logSequence: number; inserted: boolean }> { const doc = this.documents.get(documentId); if (!doc) throw new Error("document not found"); const existing = doc.operations.find(item => item.operation.opId === operation.opId); if (existing) return { logSequence: existing.logSequence, inserted: false }; const logSequence = ++this.sequence; doc.operations.push({ logSequence, operation }); return { logSequence, inserted: true }; }
  async close(): Promise<void> {}
}

const store: Store = process.env.DATABASE_URL ? new Database(process.env.DATABASE_URL) : new MemoryStore();
const rooms = new Map<string, Room>();
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const json = (res: import("node:http").ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": origin }); res.end(JSON.stringify(body)); };
const send = (ws: WebSocket, message: ServerMessage): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
const usersOf = (room: Room): Array<{ clientId: string; displayName: string; cursor: number | null }> => [...room.users.values()].map(({ clientId, displayName, cursor }) => ({ clientId, displayName, cursor }));
const broadcastPresence = (documentId: string, room: Room): void => { for (const user of room.users.values()) send(user.ws, { v: 1, type: "presence", documentId, users: usersOf(room) }); };
const reject = (ws: WebSocket, documentId: string, code: string, message: string): void => send(ws, { v: 1, type: "error", documentId, code, message });

async function loadRoom(documentId: string, knownClock: VectorClock): Promise<Room> {
  let room = rooms.get(documentId);
  if (!room) { room = { replica: createReplica(`server:${documentId}`), users: new Map() }; rooms.set(documentId, room); }
  const operations = await store.getOperations(documentId, knownClock);
  for (const { operation } of operations) room.replica.applyOperation(operation);
  return room;
}

const httpServer = createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
  if (req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "POST" && req.url === "/api/documents") {
    let body = ""; req.on("data", chunk => { body += chunk; if (body.length > 10_000) req.destroy(); });
    req.on("end", async () => { try { const parsed = body ? JSON.parse(body) : {}; const doc = await store.createDocument(typeof parsed.title === "string" ? parsed.title : undefined); json(res, 201, { documentId: doc.id, token: doc.token, title: doc.title, shareUrl: `${origin}/document/${doc.id}?token=${encodeURIComponent(doc.token)}` }); } catch { json(res, 500, { error: "Could not create document" }); } });
    return;
  }
  json(res, 404, { error: "Not found" });
});

const wsServer = new WebSocketServer({ server: httpServer, maxPayload: 256 * 1024 });
const connectionState = new Map<WebSocket, { documentId?: string; room?: Room; user?: User; windowStart: number; count: number }>();
wsServer.on("connection", (ws, req: IncomingMessage) => {
  const requestOrigin = req.headers.origin;
  if (requestOrigin && requestOrigin !== origin) { ws.close(1008, "Origin not allowed"); return; }
  const state: { documentId?: string; room?: Room; user?: User; windowStart: number; count: number } = { windowStart: Date.now(), count: 0 };
  connectionState.set(ws, state);
  ws.on("message", async raw => {
    if (Date.now() - state.windowStart > 60_000) { state.windowStart = Date.now(); state.count = 0; }
    if (++state.count > 240) return reject(ws, state.documentId ?? "unknown", "RATE_LIMIT", "Too many messages");
    let message: ClientMessage;
    try { message = clientMessageSchema.parse(JSON.parse(raw.toString())); } catch { return reject(ws, state.documentId ?? "unknown", "INVALID_MESSAGE", "Malformed protocol message"); }
    try {
      if (message.type === "join") {
        if (!(await store.authorize(message.documentId, message.token))) return reject(ws, message.documentId, "UNAUTHORIZED", "Invalid share token");
        const room = await loadRoom(message.documentId, message.knownClock); const user: User = { ws, clientId: message.clientId, displayName: message.displayName, cursor: null };
        state.documentId = message.documentId; state.room = room; state.user = user; room.users.set(ws, user);
        const stored = await store.getOperations(message.documentId, message.knownClock);
        const serverClock: VectorClock = {}; for (const { operation } of stored) serverClock[operation.actorId] = Math.max(serverClock[operation.actorId] ?? 0, operation.seq);
        send(ws, { v: PROTOCOL_VERSION, type: "sync", documentId: message.documentId, operations: stored.map(item => item.operation), serverClock, presence: usersOf(room) }); broadcastPresence(message.documentId, room); return;
      }
      if (!state.documentId || !state.room || !state.user || message.documentId !== state.documentId) return reject(ws, message.documentId, "NOT_JOINED", "Join a document first");
      if (message.type === "presence") { state.user.cursor = message.cursor; broadcastPresence(message.documentId, state.room); return; }
      if (message.type === "leave") { ws.close(1000, "left"); return; }
      if (message.type === "sync") { const stored = await store.getOperations(message.documentId, message.knownClock); send(ws, { v: 1, type: "sync", documentId: message.documentId, operations: stored.map(item => item.operation), serverClock: state.room.replica.getVectorClock(), presence: usersOf(state.room) }); return; }
      if (message.type === "submit") {
        const operation = operationSchema.parse(message.operation) as Operation;
        if (operation.actorId !== state.user.clientId) return reject(ws, message.documentId, "INVALID_ACTOR", "Operation actor does not match connection");
        const result = await store.appendOperation(message.documentId, operation);
        state.room.replica.applyOperation(operation);
        send(ws, { v: 1, type: "ack", documentId: message.documentId, opId: operation.opId, logSequence: result.logSequence });
        if (result.inserted) for (const other of state.room.users.values()) if (other.ws !== ws) send(other.ws, { v: 1, type: "operation", documentId: message.documentId, operation, logSequence: result.logSequence });
      }
    } catch (error) { reject(ws, state.documentId ?? "unknown", "SERVER_ERROR", error instanceof Error ? error.message : "Request failed"); }
  });
  ws.on("close", () => { if (state.documentId && state.room && state.user) { state.room.users.delete(ws); broadcastPresence(state.documentId, state.room); } connectionState.delete(ws); });
});

const port = Number(process.env.PORT ?? 8080);
async function start(): Promise<void> {
  if (store instanceof Database) await store.migrate();
  httpServer.listen(port, () => console.log(`collaboration server listening on http://localhost:${port}`));
}
start().catch(error => { console.error("server startup failed", error); process.exitCode = 1; });
process.on("SIGTERM", async () => { await store.close(); httpServer.close(); });
