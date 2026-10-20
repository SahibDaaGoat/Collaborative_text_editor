"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export default function HomePage() {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function createDocument(): Promise<void> {
    setBusy(true); setError("");
    try { const response = await fetch(`${API_URL}/api/documents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }); if (!response.ok) throw new Error("Document creation failed"); const data = await response.json(); router.push(`/document/${data.documentId}?token=${encodeURIComponent(data.token)}`); } catch (err) { setError(err instanceof Error ? err.message : "Could not create document"); } finally { setBusy(false); }
  }
  return <main className="home-shell"><section className="home-card"><div className="brand-mark">↗</div><p className="eyebrow">REAL-TIME WORKSPACE</p><h1>Write together,<br /><em>without waiting.</em></h1><p className="intro">A focused collaborative editor powered by a custom operation-based CRDT. Create a document, share the link, and edit in sync.</p><button className="primary-button" onClick={createDocument} disabled={busy}>{busy ? "Creating…" : "Create a document"}<span>→</span></button>{error && <p className="error-text">{error}</p>}<p className="fine-print">No account required · Share links are private bearer credentials</p></section><aside className="home-aside"><div className="aside-grid" /><div className="quote">“The best ideas get better<br />when they have room to move.”</div><div className="aside-footer"><span>v1.0 · custom RGA</span><span>PG · WS · Tiptap</span></div></aside></main>;
}
