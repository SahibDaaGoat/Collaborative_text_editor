/**
 * A small operation-based RGA sequence CRDT.
 *
 * Ordering rule: every element is a child of its `after` element. Children
 * are ordered by the reverse total order (clientId, counter), and traversal is
 * depth-first: a child and all of its descendants are emitted before the next
 * sibling. This makes concurrent inserts deterministic without timestamps.
 * Deletions only set tombstones, so descendants remain addressable.
 */

export type ClientId = string;
export type ElementId = { clientId: ClientId; counter: number };
export type VectorClock = Record<ClientId, number>;

export type InsertOperation = {
  kind: "insert";
  opId: string;
  actorId: ClientId;
  seq: number;
  deps: VectorClock;
  element: { id: ElementId; after: ElementId | null; value: string };
};

export type DeleteOperation = {
  kind: "delete";
  opId: string;
  actorId: ClientId;
  seq: number;
  deps: VectorClock;
  elementIds: ElementId[];
};

export type Operation = InsertOperation | DeleteOperation;

export type ExportedState = {
  version: 1;
  clientId: ClientId;
  nextCounter: number;
  vectorClock: VectorClock;
  elements: Array<{
    id: ElementId;
    after: ElementId | null;
    value: string;
    tombstone: boolean;
  }>;
  pendingOperations: Operation[];
  pendingDeletions: ElementId[];
  appliedOperationIds: string[];
};

type Element = ExportedState["elements"][number];

const keyOf = (id: ElementId | null): string => id ? `${id.clientId}:${id.counter}` : "root";
const cloneClock = (clock: VectorClock): VectorClock => ({ ...clock });
const compareIds = (a: ElementId, b: ElementId): number =>
  a.clientId.localeCompare(b.clientId) || a.counter - b.counter;
const sameId = (a: ElementId, b: ElementId): boolean => keyOf(a) === keyOf(b);

export class RgaReplica {
  readonly clientId: ClientId;
  private nextCounter: number;
  private readonly elements = new Map<string, Element>();
  private readonly children = new Map<string, Set<string>>([["root", new Set()]]);
  private readonly pendingOperations = new Map<string, Operation>();
  private readonly pendingDeletions = new Map<string, ElementId>();
  private readonly appliedOperationIds = new Set<string>();
  private readonly vectorClock: VectorClock;

  constructor(clientId: ClientId, state?: ExportedState) {
    if (!clientId.trim()) throw new Error("clientId is required");
    this.clientId = clientId;
    this.nextCounter = 0;
    this.vectorClock = {};
    if (state) this.loadState(state);
  }

  private loadState(state: ExportedState): void {
    if (state.version !== 1) throw new Error("Unsupported CRDT state version");
    this.nextCounter = state.nextCounter;
    Object.assign(this.vectorClock, state.vectorClock);
    for (const element of state.elements) {
      this.elements.set(keyOf(element.id), { ...element, id: { ...element.id }, after: element.after && { ...element.after } });
      const parent = keyOf(element.after);
      if (!this.children.has(parent)) this.children.set(parent, new Set());
      this.children.get(parent)!.add(keyOf(element.id));
      if (!this.children.has(keyOf(element.id))) this.children.set(keyOf(element.id), new Set());
    }
    for (const op of state.pendingOperations) this.pendingOperations.set(op.opId, op);
    for (const id of state.pendingDeletions) this.pendingDeletions.set(keyOf(id), id);
    for (const opId of state.appliedOperationIds) this.appliedOperationIds.add(opId);
  }

  getVectorClock(): VectorClock { return cloneClock(this.vectorClock); }

  insert(anchorId: ElementId | null, value: string): InsertOperation[] {
    if (!value) return [];
    if (anchorId && !this.elements.has(keyOf(anchorId))) throw new Error("Unknown insertion anchor");
    let anchor = anchorId;
    const operations: InsertOperation[] = [];
    for (const unit of Array.from(value)) {
      const seq = this.allocateCounter();
      const element = { id: { clientId: this.clientId, counter: seq }, after: anchor && { ...anchor }, value: unit };
      const op: InsertOperation = { kind: "insert", opId: this.opId(seq), actorId: this.clientId, seq, deps: this.getVectorClock(), element };
      this.applyOperation(op);
      operations.push(op);
      anchor = element.id;
    }
    return operations;
  }

  delete(elementIds: ElementId[]): DeleteOperation | null {
    const unique = [...new Map(elementIds.map(id => [keyOf(id), id])).values()];
    if (!unique.length) return null;
    const seq = this.allocateCounter();
    const op: DeleteOperation = { kind: "delete", opId: this.opId(seq), actorId: this.clientId, seq, deps: this.getVectorClock(), elementIds: unique.map(id => ({ ...id })) };
    this.applyOperation(op);
    return op;
  }

  applyOperation(operation: Operation): boolean {
    if (this.appliedOperationIds.has(operation.opId)) return false;
    if (operation.kind === "insert") {
      const idKey = keyOf(operation.element.id);
      const existing = this.elements.get(idKey);
      if (existing) {
        this.appliedOperationIds.add(operation.opId);
        this.updateClock(operation);
        return false;
      }
      const parentKey = keyOf(operation.element.after);
      if (operation.element.after && !this.elements.has(parentKey)) {
        this.pendingOperations.set(operation.opId, operation);
        return false;
      }
      const element: Element = { id: { ...operation.element.id }, after: operation.element.after && { ...operation.element.after }, value: operation.element.value, tombstone: this.pendingDeletions.has(idKey) };
      this.elements.set(idKey, element);
      if (!this.children.has(parentKey)) this.children.set(parentKey, new Set());
      this.children.get(parentKey)!.add(idKey);
      if (!this.children.has(idKey)) this.children.set(idKey, new Set());
      this.pendingDeletions.delete(idKey);
      this.pendingOperations.delete(operation.opId);
      this.appliedOperationIds.add(operation.opId);
      this.updateClock(operation);
      this.retryPending();
      return true;
    }

    let changed = false;
    for (const id of operation.elementIds) {
      const idKey = keyOf(id);
      const element = this.elements.get(idKey);
      if (element) {
        if (!element.tombstone) { element.tombstone = true; changed = true; }
      } else this.pendingDeletions.set(idKey, { ...id });
    }
    this.appliedOperationIds.add(operation.opId);
    this.updateClock(operation);
    return changed;
  }

  private retryPending(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (const op of [...this.pendingOperations.values()]) if (this.applyOperation(op)) progress = true;
    }
  }

  private updateClock(op: Operation): void { this.vectorClock[op.actorId] = Math.max(this.vectorClock[op.actorId] ?? 0, op.seq); }
  private allocateCounter(): number { this.nextCounter += 1; return this.nextCounter; }
  private opId(seq: number): string { return `${this.clientId}:${seq}`; }

  getVisibleElements(): Element[] {
    const result: Element[] = [];
    const visit = (parentKey: string): void => {
      const childIds = [...(this.children.get(parentKey) ?? [])]
        .map(id => this.elements.get(id)!)
        .sort((a, b) => compareIds(b.id, a.id));
      for (const child of childIds) { if (!child.tombstone) result.push({ ...child, id: { ...child.id }, after: child.after && { ...child.after } }); visit(keyOf(child.id)); }
    };
    visit("root");
    return result;
  }

  getText(): string { return this.getVisibleElements().map(element => element.value).join(""); }
  getPendingOperations(): Operation[] { return [...this.pendingOperations.values()]; }

  exportState(): ExportedState {
    return {
      version: 1, clientId: this.clientId, nextCounter: this.nextCounter, vectorClock: this.getVectorClock(),
      elements: [...this.elements.values()].map(element => ({ ...element, id: { ...element.id }, after: element.after && { ...element.after } })),
      pendingOperations: [...this.pendingOperations.values()], pendingDeletions: [...this.pendingDeletions.values()], appliedOperationIds: [...this.appliedOperationIds]
    };
  }
}

export const createReplica = (clientId: ClientId, state?: ExportedState): RgaReplica => new RgaReplica(clientId, state);
export const elementIdKey = keyOf;
