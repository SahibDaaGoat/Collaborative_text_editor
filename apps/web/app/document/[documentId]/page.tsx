"use client";

import { useSearchParams } from "next/navigation";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { createReplica, type ElementId, type Operation, type RgaReplica } from "@collab/crdt";
import type { ServerMessage } from "@collab/protocol";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
type Status = "connecting" | "connected" | "reconnecting" | "offline" | "error";

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }): JSX.Element {
  return <div className="toolbar"><button onClick={() => editor?.chain().focus().toggleBold().run()} className={editor?.isActive("bold") ? "active" : ""}>B</button><button onClick={() => editor?.chain().focus().toggleItalic().run()} className={editor?.isActive("italic") ? "active italic" : "italic"}>I</button><span className="toolbar-divider" /><button onClick={() => editor?.chain().focus().setParagraph().run()}>Text</button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} className={editor?.isActive("heading", { level: 2 }) ? "active" : ""}>H2</button><button onClick={() => editor?.chain().focus().setHardBreak().run()}>↵</button></div>;
}

export default function DocumentPage(): JSX.Element {
  const params = useParams<{ documentId: string }>(); const search = useSearchParams(); const token = search.get("token") ?? "";
  const clientId = useMemo(() => { const key = "collab-client-id"; const existing = typeof window !== "undefined" ? localStorage.getItem(key) : null; if (existing) return existing; const next = crypto.randomUUID(); if (typeof window !== "undefined") localStorage.setItem(key, next); return next; }, []);
  const replicaRef = useRef<RgaReplica>(createReplica(clientId)); const socketRef = useRef<WebSocket | null>(null); const suppressRef = useRef(false); const lastTextRef = useRef(""); const pendingRef = useRef(new Map<string, Operation>());
  const [status, setStatus] = useState<Status>("connecting"); const [users, setUsers] = useState<Array<{ clientId: string; displayName: string; cursor: number | null }>>([]); const [copied, setCopied] = useState(false); const [error, setError] = useState("");
  const displayName = useMemo(() => `Guest ${clientId.slice(0, 4)}`, [clientId]);

  const editor = useEditor({ extensions: [StarterKit.configure({ history: false }), Placeholder.configure({ placeholder: "Start writing something worth sharing…" })], content: "", editorProps: { attributes: { class: "editor-prose" } }, onUpdate: ({ editor, transaction }) => {
    if (suppressRef.current) return;
    const nextText = editor.getText({ blockSeparator: "\n" }); const previousText = lastTextRef.current;
    const step = transaction.steps[0] as { from?: number; to?: number; slice?: { content?: { textBetween: (from: number, to: number, blockSeparator: string) => string; size: number } } } | undefined;
    const from = Math.max(0, (step?.from ?? 1) - 1); const to = Math.max(from, (step?.to ?? from + 1) - 1);
    const visible = replicaRef.current.getVisibleElements(); const deleted = visible.slice(from, Math.min(to, visible.length)).map(element => element.id);
    const anchor: ElementId | null = from > 0 ? visible[from - 1]?.id ?? null : null;
    if (deleted.length) { const op = replicaRef.current.delete(deleted); if (op) queueOperation(op); }
    const inserted = step?.slice?.content?.textBetween(0, step.slice.content.size, "\n") ?? (nextText.length > previousText.length ? nextText.slice(from, from + (nextText.length - previousText.length)) : "");
    if (inserted) for (const op of replicaRef.current.insert(anchor, inserted)) queueOperation(op);
    lastTextRef.current = replicaRef.current.getText();
  } });

  function queueOperation(operation: Operation): void { pendingRef.current.set(operation.opId, operation); const ws = socketRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: "submit", documentId: params.documentId, operation })); }
  function applyRemote(operations: Operation[]): void { for (const operation of operations) replicaRef.current.applyOperation(operation); const next = replicaRef.current.getText(); if (!editor || next === lastTextRef.current) return; const cursor = editor.state.selection.anchor; suppressRef.current = true; editor.commands.setContent(next ? `<p>${escapeHtml(next).replaceAll("\n", "<br>")}</p>` : "", false); editor.commands.setTextSelection(Math.min(cursor, editor.state.doc.content.size)); suppressRef.current = false; lastTextRef.current = next; }
  function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
  function connect(): void { if (!token) { setError("This document link is missing its access token."); setStatus("error"); return; } setStatus("connecting"); const ws = new WebSocket(WS_URL); socketRef.current = ws; ws.onopen = () => { setStatus("connected"); ws.send(JSON.stringify({ v: 1, type: "join", documentId: params.documentId, token, clientId, displayName, knownClock: replicaRef.current.getVectorClock() })); for (const operation of pendingRef.current.values()) ws.send(JSON.stringify({ v: 1, type: "submit", documentId: params.documentId, operation })); }; ws.onmessage = event => { try { const message = JSON.parse(event.data) as ServerMessage; if (message.type === "sync") { applyRemote(message.operations); setUsers(message.presence); } else if (message.type === "operation") applyRemote([message.operation]); else if (message.type === "ack") pendingRef.current.delete(message.opId); else if (message.type === "presence") setUsers(message.users); else if (message.type === "error") setError(message.message); } catch { setError("Received an invalid server message."); } }; ws.onclose = () => { setStatus("reconnecting"); window.setTimeout(() => { if (socketRef.current === ws) connect(); }, 1200); }; ws.onerror = () => setStatus("offline"); }
  // The connection is intentionally created once per editor instance; its handlers own reconnect state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!editor) return; connect(); return () => { socketRef.current?.close(); }; }, [editor]);
  function copyLink(): void { void navigator.clipboard.writeText(window.location.href).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }); }
  const statusLabel = status === "connected" ? "Saved & synced" : status === "reconnecting" ? "Reconnecting…" : status === "offline" ? "Offline" : "Connecting…";
  return <main className="editor-shell"><header className="editor-header"><a href="/" className="wordmark">north<span>↗</span></a><div className="doc-meta"><div className="doc-title">Untitled document</div><div className="doc-status"><span className={`status-dot ${status}`} />{statusLabel}</div></div><div className="header-actions"><div className="presence-stack">{users.slice(0, 4).map(user => <span key={user.clientId} title={user.displayName} className="avatar">{user.displayName.slice(0, 1)}</span>)}<span className="user-count">{users.length || 1} {users.length === 1 ? "editor" : "editors"}</span></div><button className="share-button" onClick={copyLink}>{copied ? "Copied!" : "Share link"}<span>↗</span></button></div></header><section className="editor-card"><Toolbar editor={editor} /><div className="paper"><EditorContent editor={editor} /></div><footer className="editor-footer"><span>Plain text collaboration · custom RGA sequence</span><span>{error ? <b className="error-text">{error}</b> : "Changes are persisted before they are shared"}</span></footer></section></main>;
}
