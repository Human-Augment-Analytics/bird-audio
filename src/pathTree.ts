export interface TreeDirNode<T> {
  type: "dir";
  name: string;
  /** Path relative to the tree's root, e.g. "SITE_A/2025-06". */
  path: string;
  children: TreeNode<T>[];
}

export interface TreeFileNode<T> {
  type: "file";
  name: string;
  item: T;
}

export type TreeNode<T> = TreeDirNode<T> | TreeFileNode<T>;

/** Path relative to `root`, with a leading/trailing slash stripped. */
export function relativePath(path: string, root: string): string {
  let rel = path;
  if (root && path.startsWith(root)) {
    rel = path.slice(root.length);
  }
  return rel.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** The folder portion of `path` relative to `root` (no trailing filename). */
export function relativeDir(path: string, root: string): string {
  const rel = relativePath(path, root);
  const parts = rel.split("/");
  parts.pop();
  return parts.join("/");
}

/**
 * Groups items by the directory structure of their `path`, relative to
 * `root`. Multiple files sharing a basename land in different branches when
 * their folder paths differ — that's the whole point of the tree.
 */
export function buildTree<T extends { path: string }>(items: T[], root: string): TreeDirNode<T> {
  const rootNode: TreeDirNode<T> = { type: "dir", name: "", path: "", children: [] };
  const dirIndex = new Map<string, TreeDirNode<T>>();
  dirIndex.set("", rootNode);

  for (const item of items) {
    const rel = relativePath(item.path, root);
    const parts = rel.split("/").filter(Boolean);
    const fileName = parts.pop() ?? rel;
    let curPath = "";
    let cur = rootNode;
    for (const part of parts) {
      curPath = curPath ? `${curPath}/${part}` : part;
      let child = dirIndex.get(curPath);
      if (!child) {
        child = { type: "dir", name: part, path: curPath, children: [] };
        dirIndex.set(curPath, child);
        cur.children.push(child);
      }
      cur = child;
    }
    cur.children.push({ type: "file", name: fileName, item });
  }
  sortTree(rootNode);
  return rootNode;
}

/** Total number of file leaves under a directory node, recursively. */
export function countFiles<T>(node: TreeDirNode<T>): number {
  let n = 0;
  for (const c of node.children) n += c.type === "file" ? 1 : countFiles(c);
  return n;
}

function sortTree<T>(node: TreeDirNode<T>) {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) if (c.type === "dir") sortTree(c);
}
