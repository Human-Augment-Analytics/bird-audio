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
  // Fold linear folder chains (a → b → c) into one "a/b/c" node so deep nests
  // don't force the researcher to expand one folder at a time. The root stays a
  // container (it isn't rendered), so its own children keep their labels.
  for (const c of rootNode.children) if (c.type === "dir") collapseChain(c);
  return rootNode;
}

/** Absorb single-dir-child chains into `node`, bottom-up, joining names with
 * "/". A folder with exactly one subfolder and nothing else becomes one row. */
function collapseChain<T>(node: TreeDirNode<T>) {
  for (const c of node.children) if (c.type === "dir") collapseChain(c);
  while (node.children.length === 1 && node.children[0].type === "dir") {
    const child = node.children[0];
    node.name = node.name ? `${node.name}/${child.name}` : child.name;
    node.path = child.path;
    node.children = child.children;
  }
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
