import { describe, expect, it } from "vitest";
import { createReplica, InsertOperation } from "./index";

const exchange = (a: ReturnType<typeof createReplica>, b: ReturnType<typeof createReplica>, ops: InsertOperation[]): void => ops.forEach(op => { a.applyOperation(op); b.applyOperation(op); });

describe("RGA replica", () => {
  it("inserts and deletes Unicode text", () => {
    const r = createReplica("a");
    const ops = r.insert(null, "Hi 👋");
    expect(r.getText()).toBe("Hi 👋");
    r.delete([ops[1].element.id]);
    expect(r.getText()).toBe("H 👋");
  });

  it("converges for concurrent inserts at the same anchor", () => {
    const a = createReplica("a"); const b = createReplica("b");
    const ao = a.insert(null, "A")[0]; const bo = b.insert(null, "B")[0];
    a.applyOperation(bo); b.applyOperation(ao);
    expect(a.getText()).toBe(b.getText());
    expect(a.getText()).toBe("BA");
  });

  it("buffers missing predecessors and handles delete-before-insert", () => {
    const a = createReplica("a"); const b = createReplica("b");
    const first = a.insert(null, "a")[0]; const second = a.insert(first.element.id, "b")[0];
    const deletion = b.delete([second.element.id])!;
    expect(b.getText()).toBe("");
    b.applyOperation(second); b.applyOperation(first); b.applyOperation(deletion);
    expect(b.getText()).toBe("a");
  });

  it("is idempotent and survives export/import", () => {
    const a = createReplica("a"); const op = a.insert(null, "hello")[0];
    expect(a.applyOperation(op)).toBe(false);
    const copy = createReplica("copy", a.exportState());
    expect(copy.getText()).toBe("hello");
  });

  it("supports delayed descendants", () => {
    const a = createReplica("a"); const ops = a.insert(null, "abc");
    const b = createReplica("b");
    b.applyOperation(ops[2]); b.applyOperation(ops[0]); b.applyOperation(ops[1]);
    expect(b.getText()).toBe("abc");
  });

  it("supports beginning, middle, end, and multi-element deletion", () => {
    const r = createReplica("a");
    const middle = r.insert(null, "ac");
    const beginning = r.insert(null, "b")[0];
    const end = r.insert(middle[1].element.id, "d")[0];
    expect(r.getText()).toBe("bacd");
    r.delete([middle[0].element.id, end.element.id]);
    expect(r.getText()).toBe("bc");
    expect(beginning.element.value).toBe("b");
  });

  it("converges when independent operation batches are shuffled", () => {
    const a = createReplica("a"); const b = createReplica("b"); const c = createReplica("c");
    const aOps = a.insert(null, "one"); const bOps = b.insert(null, "two"); const cOps = c.insert(null, "three");
    const all = [...aOps, ...bOps, ...cOps].reverse();
    for (const op of all) { a.applyOperation(op); b.applyOperation(op); c.applyOperation(op); }
    expect(new Set([a.getText(), b.getText(), c.getText()]).size).toBe(1);
  });
});
