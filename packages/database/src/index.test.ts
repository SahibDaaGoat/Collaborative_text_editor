import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

describe("database contract", () => {
  it("uses a uniqueness constraint and append-only log", () => {
    const schema = readFileSync("packages/database/src/schema.sql", "utf8");
    expect(schema).toContain("UNIQUE(document_id, operation_id)");
    expect(schema).toContain("BIGSERIAL");
    expect(createHash("sha256").update("token").digest("hex")).toHaveLength(64);
  });
});
