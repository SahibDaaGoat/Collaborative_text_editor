import { z } from "zod";
import type { Operation, VectorClock } from "@collab/crdt";

export const PROTOCOL_VERSION = 1;
export const operationSchema = z.object({
  kind: z.enum(["insert", "delete"]), opId: z.string().min(3).max(180), actorId: z.string().min(1).max(80), seq: z.number().int().positive(), deps: z.record(z.string(), z.number().int().nonnegative()),
  element: z.object({ id: z.object({ clientId: z.string().min(1).max(80), counter: z.number().int().positive() }), after: z.object({ clientId: z.string(), counter: z.number().int().positive() }).nullable(), value: z.string().min(1).max(8) }).optional(),
  elementIds: z.array(z.object({ clientId: z.string().min(1).max(80), counter: z.number().int().positive() })).max(200).optional()
}).superRefine((op, ctx) => {
  if (op.kind === "insert" && !op.element) ctx.addIssue({ code: "custom", message: "insert requires element" });
  if (op.kind === "delete" && !op.elementIds) ctx.addIssue({ code: "custom", message: "delete requires elementIds" });
});

const envelope = z.object({ v: z.literal(PROTOCOL_VERSION), type: z.string(), documentId: z.string().min(16).max(128) });
export const clientMessageSchema = z.discriminatedUnion("type", [
  envelope.extend({ type: z.literal("join"), token: z.string().min(32).max(256), clientId: z.string().min(1).max(80), displayName: z.string().min(1).max(40), knownClock: z.record(z.string(), z.number().int().nonnegative()).default({}) }),
  envelope.extend({ type: z.literal("submit"), operation: operationSchema }),
  envelope.extend({ type: z.literal("sync"), knownClock: z.record(z.string(), z.number().int().nonnegative()).default({}) }),
  envelope.extend({ type: z.literal("presence"), cursor: z.number().int().nonnegative().max(100000).nullable() }),
  envelope.extend({ type: z.literal("leave") })
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { v: 1; type: "sync"; documentId: string; operations: Operation[]; serverClock: VectorClock; presence: Array<{ clientId: string; displayName: string; cursor: number | null }> }
  | { v: 1; type: "operation"; documentId: string; operation: Operation; logSequence: number }
  | { v: 1; type: "ack"; documentId: string; opId: string; logSequence: number }
  | { v: 1; type: "presence"; documentId: string; users: Array<{ clientId: string; displayName: string; cursor: number | null }> }
  | { v: 1; type: "error"; documentId: string; code: string; message: string };

export function parseClientMessage(input: string): ClientMessage {
  if (input.length > 256_000) throw new Error("message too large");
  return clientMessageSchema.parse(JSON.parse(input));
}
