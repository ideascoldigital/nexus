import type { LeafNode, SplitNode, TerminalNode } from "./terminal-types";

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function makeLeaf(cwd: string, shellId?: string): LeafNode {
  return { kind: "leaf", id: newId("leaf"), cwd, shellId };
}

export function findLeaf(node: TerminalNode, id: string): LeafNode | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, id);
    if (found) return found;
  }
  return null;
}

export function findFirstLeaf(node: TerminalNode): LeafNode | null {
  if (node.kind === "leaf") return node;
  for (const child of node.children) {
    const f = findFirstLeaf(child);
    if (f) return f;
  }
  return null;
}

export function collectLeaves(node: TerminalNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  return node.children.flatMap(collectLeaves);
}

export function splitLeaf(
  node: TerminalNode,
  leafId: string,
  dir: "horizontal" | "vertical",
  newCwd: string,
  newShellId?: string
): { root: TerminalNode; newLeafId: string } | null {
  if (node.kind === "leaf") {
    if (node.id !== leafId) return null;
    const newLeaf = makeLeaf(newCwd, newShellId);
    const split: SplitNode = {
      kind: "split",
      id: newId("split"),
      dir,
      children: [node, newLeaf],
    };
    return { root: split, newLeafId: newLeaf.id };
  }
  for (let i = 0; i < node.children.length; i++) {
    const result = splitLeaf(node.children[i], leafId, dir, newCwd, newShellId);
    if (result) {
      // If parent split has same dir, flatten by inserting sibling instead of nesting
      if (
        result.root.kind === "split" &&
        result.root.dir === node.dir &&
        node.children[i].kind === "leaf"
      ) {
        const flat: SplitNode = {
          ...node,
          children: [
            ...node.children.slice(0, i),
            ...result.root.children,
            ...node.children.slice(i + 1),
          ],
        };
        return { root: flat, newLeafId: result.newLeafId };
      }
      const next: SplitNode = {
        ...node,
        children: [
          ...node.children.slice(0, i),
          result.root,
          ...node.children.slice(i + 1),
        ],
      };
      return { root: next, newLeafId: result.newLeafId };
    }
  }
  return null;
}

export function removeLeaf(
  node: TerminalNode,
  leafId: string
): TerminalNode | null {
  if (node.kind === "leaf") {
    return node.id === leafId ? null : node;
  }
  const filtered: TerminalNode[] = [];
  for (const child of node.children) {
    const next = removeLeaf(child, leafId);
    if (next) filtered.push(next);
  }
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0];
  return { ...node, children: filtered };
}
