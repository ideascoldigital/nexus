"use client";

import { RealTerminal } from "@/components/terminal/real-terminal";
import { AppHeader } from "@/components/layout/app-header";

export default function TerminalPage() {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AppHeader title="Terminal" />

      <div className="flex-1 min-h-0 p-4">
        <div className="mx-auto h-full w-full max-w-6xl rounded-lg overflow-hidden border shadow-sm">
          <RealTerminal />
        </div>
      </div>
    </div>
  );
}
