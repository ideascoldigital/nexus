import type { ReactNode } from "react";

// The simple view: bots and nothing else. Deliberately outside the dashboard's
// AppShell — no workspace sidebar, header, status bar or command palette.
export default function BotsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bots-ui flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
      {children}
    </div>
  );
}
