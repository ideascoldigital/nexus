"use client";

import { Group, Panel, Separator } from "react-resizable-panels";
import {
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";

import type { TerminalNode } from "./terminal-types";

interface TerminalPaneProps {
  node: TerminalNode;
  activeLeafId: string;
  onActivate: (leafId: string) => void;
  onSplit: (leafId: string, dir: "horizontal" | "vertical") => void;
  onClose: (leafId: string) => void;
  getSlotRef: (leafId: string) => (el: HTMLElement | null) => void;
}

export function TerminalPane(props: TerminalPaneProps) {
  const { node } = props;

  if (node.kind === "leaf") {
    const isActive = node.id === props.activeLeafId;
    return (
      <div
        onMouseDown={() => props.onActivate(node.id)}
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-md border bg-[#040609] ${
          isActive ? "border-primary/50" : "border-border/40"
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-[10px] text-muted-foreground border-b border-border/40 bg-muted/30">
          <span className="truncate" title={node.cwd}>
            {node.cwd}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onSplit(node.id, "horizontal");
              }}
              title="Split right"
              className="rounded p-0.5 hover:bg-accent"
            >
              <SplitSquareHorizontal className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onSplit(node.id, "vertical");
              }}
              title="Split down"
              className="rounded p-0.5 hover:bg-accent"
            >
              <SplitSquareVertical className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(node.id);
              }}
              title="Close pane"
              className="rounded p-0.5 hover:bg-destructive/20"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0" ref={props.getSlotRef(node.id)} />
      </div>
    );
  }

  return (
    <Group
      orientation={node.dir}
      className={`flex h-full w-full ${
        node.dir === "horizontal" ? "flex-row" : "flex-col"
      }`}
    >
      {node.children.map((child, i) => (
        <PanelGroupItem
          key={child.id}
          child={child}
          isFirst={i === 0}
          dir={node.dir}
          paneProps={props}
        />
      ))}
    </Group>
  );
}

function PanelGroupItem({
  child,
  isFirst,
  dir,
  paneProps,
}: {
  child: TerminalNode;
  isFirst: boolean;
  dir: "horizontal" | "vertical";
  paneProps: TerminalPaneProps;
}) {
  return (
    <>
      {!isFirst && (
        <Separator
          className={
            dir === "horizontal"
              ? "w-1 shrink-0 bg-transparent hover:bg-primary/40 transition-colors"
              : "h-1 shrink-0 bg-transparent hover:bg-primary/40 transition-colors"
          }
        />
      )}
      <Panel minSize="10%" className="min-h-0 min-w-0">
        <TerminalPane {...paneProps} node={child} />
      </Panel>
    </>
  );
}
