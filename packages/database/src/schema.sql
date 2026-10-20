CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY,
  share_token_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT 'Untitled document',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS document_operations (
  log_sequence BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('insert', 'delete')),
  payload JSONB NOT NULL,
  causal_metadata JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id, operation_id)
);
CREATE INDEX IF NOT EXISTS document_operations_document_order ON document_operations(document_id, log_sequence);
CREATE INDEX IF NOT EXISTS document_operations_document_operation ON document_operations(document_id, operation_id);
