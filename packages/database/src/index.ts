import { Pool, PoolClient } from "pg";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Operation } from "@collab/crdt";

export type DocumentRecord = { id: string; token: string; title: string };
export type StoredOperation = { logSequence: number; operation: Operation };

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class Database {
  readonly pool: Pool;
  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    this.pool = new Pool({ connectionString, max: 10 });
  }
  async migrate(): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(join(process.cwd(), "packages", "database", "src", "schema.sql"), "utf8");
    await this.pool.query(sql);
  }
  async createDocument(title = "Untitled document"): Promise<DocumentRecord> {
    const id = randomUUID(); const token = randomBytes(32).toString("base64url");
    await this.pool.query("INSERT INTO documents (id, share_token_hash, title) VALUES ($1, $2, $3)", [id, hashToken(token), title.slice(0, 160)]);
    return { id, token, title };
  }
  async authorize(documentId: string, token: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM documents WHERE id = $1 AND share_token_hash = $2", [documentId, hashToken(token)]);
    return result.rowCount === 1;
  }
  async getOperations(documentId: string, knownClock: Record<string, number>): Promise<StoredOperation[]> {
    const result = await this.pool.query("SELECT log_sequence, payload FROM document_operations WHERE document_id = $1 ORDER BY log_sequence ASC", [documentId]);
    return result.rows.filter(row => (knownClock[row.payload.actorId] ?? 0) < row.payload.seq).map(row => ({ logSequence: Number(row.log_sequence), operation: row.payload as Operation }));
  }
  async appendOperation(documentId: string, operation: Operation): Promise<{ logSequence: number; inserted: boolean }> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("INSERT INTO document_operations (document_id, operation_id, actor_id, operation_type, payload, causal_metadata) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (document_id, operation_id) DO NOTHING RETURNING log_sequence", [documentId, operation.opId, operation.actorId, operation.kind, operation, operation.deps]);
      await client.query("COMMIT");
      if (!result.rowCount) {
        const existing = await this.pool.query("SELECT log_sequence FROM document_operations WHERE document_id=$1 AND operation_id=$2", [documentId, operation.opId]);
        return { logSequence: Number(existing.rows[0]?.log_sequence ?? 0), inserted: false };
      }
      return { logSequence: Number(result.rows[0].log_sequence), inserted: true };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
