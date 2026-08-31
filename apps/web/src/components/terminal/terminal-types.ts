export type LeafNode = {
  kind: "leaf";
  id: string;
  cwd: string;
  /**
   * Shell id for this pane (`powershell`, `cmd`, `wsl:Ubuntu-24.04`, `posix`).
   * Undefined means "whatever this machine's default is", which is also what
   * every pane saved before shells were selectable resolves to.
   */
  shellId?: string;
};

export type SplitNode = {
  kind: "split";
  id: string;
  dir: "horizontal" | "vertical";
  children: TerminalNode[];
};

export type TerminalNode = LeafNode | SplitNode;

export type TerminalTab = {
  id: string;
  title: string;
  root: TerminalNode;
  activeLeafId: string;
};

export type TerminalsState = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};
