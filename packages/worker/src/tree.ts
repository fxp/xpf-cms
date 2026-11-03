import type { GithubLike, TreeEntry } from "./github.ts";

const enc = new TextEncoder();

/**
 * GitHub's "create a tree" call accepts at most ~7 MB of inline `content` (and 100k entries) per request; a refresh of graph/
 * is tens of MB. So the entries go in batches, each one based on the tree the previous one produced. The result is the same
 * tree a single call would have made.
 */
export async function createTreeChunked(
  gh: Pick<GithubLike, "createTree">, baseTree: string, entries: TreeEntry[],
  limits: { bytes: number; entries: number } = { bytes: 4 * 1024 * 1024, entries: 1500 },
): Promise<string> {
  let tree = baseTree, batch: TreeEntry[] = [], bytes = 0;
  const flush = async () => { if (batch.length) { tree = await gh.createTree(tree, batch); batch = []; bytes = 0; } };
  for (const e of entries) {
    const size = e.content === undefined ? 0 : enc.encode(e.content).length;
    if (batch.length && (bytes + size > limits.bytes || batch.length >= limits.entries)) await flush();
    batch.push(e);
    bytes += size;
  }
  await flush();
  return tree;
}
