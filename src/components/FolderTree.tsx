import { useState, type ReactNode } from "react";
import type { TreeDirNode, TreeNode } from "../pathTree";

interface FolderTreeProps<T> {
  root: TreeDirNode<T>;
  renderLeaf: (item: T) => ReactNode;
  leafKey: (item: T) => string;
  /** Extra content rendered inline next to a folder's name, e.g. a file count. */
  renderFolderMeta?: (dir: TreeDirNode<T>) => ReactNode;
}

/** Collapsible recursive renderer for a tree built with `buildTree` (see ../pathTree). */
export function FolderTree<T>({ root, renderLeaf, leafKey, renderFolderMeta }: FolderTreeProps<T>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: TreeNode<T>, depth: number): ReactNode => {
    if (node.type === "file") {
      return <div key={leafKey(node.item)} style={{ paddingLeft: depth * 14 }}>{renderLeaf(node.item)}</div>;
    }
    const isRoot = node.path === "";
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={node.path || "__root"}>
        {!isRoot && (
          <button
            onClick={() => toggle(node.path)}
            title={node.path}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%",
              padding: `5px 12px 5px ${depth * 14 + 12}px`,
              background: "none", border: "none", cursor: "pointer", textAlign: "left",
              fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.03em",
              color: "var(--text-faint)", fontWeight: 600,
            }}
          >
            <span style={{ width: 10, flex: "none", opacity: 0.7 }}>{isCollapsed ? "▸" : "▾"}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
            {renderFolderMeta?.(node)}
          </button>
        )}
        {!isCollapsed && node.children.map((c) => renderNode(c, isRoot ? depth : depth + 1))}
      </div>
    );
  };

  return <>{root.children.map((c) => renderNode(c, 0))}</>;
}
