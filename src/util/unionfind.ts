/**
 * Connected components by union-find: how the islands and the fog's backstage search part a map's
 * leaves. docs/render-bsp.md § Islands, docs/fogofwar.md § Arena.
 */

/** Disjoint sets over `0` to `size - 1`, each element starting in a set of its own. */
export class UnionFind {
  private parent: Int32Array;
  private sets: number;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
    this.sets = size;
  }

  /** How many sets there are, and so the ids {@link UnionFind.ids} hands out. */
  get count(): number {
    return this.sets;
  }

  /** Joins the sets holding `a` and `b`. */
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent[ra] = rb;
    this.sets--;
  }

  /** Each element's set as a dense id, numbered in the order each set's first element comes. */
  ids(): Int32Array {
    const out = new Int32Array(this.parent.length);
    const idOfRoot = new Int32Array(this.parent.length).fill(-1);
    let next = 0;
    for (let i = 0; i < out.length; i++) {
      const root = this.find(i);
      if (idOfRoot[root] < 0) idOfRoot[root] = next++;
      out[i] = idOfRoot[root];
    }
    return out;
  }

  /** The root of `a`'s set, halving the path on the way up. */
  private find(a: number): number {
    const parent = this.parent;
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }
}
