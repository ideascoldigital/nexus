"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  NEXUS_TERMINAL_FONT,
  NEXUS_TERMINAL_THEME,
} from "./terminal-theme";

interface RealTerminalProps {
  workingDirectory?: string;
  /**
   * Which shell to run (`powershell`, `cmd`, `wsl:Ubuntu-24.04`, `posix`).
   * Omitted means the server picks this machine's default — which is what a
   * pane restored from before shells were selectable gets.
   */
  shellId?: string;
  /**
   * If provided, terminal root DOM is appended into this element via
   * appendChild and reparented on changes. The terminal instance and WS
   * survive slot changes.
   */
  slot?: HTMLElement | null;
  /** Bumped by parent when slot map changes; forces reparent re-check. */
  slotsVersion?: number;
}

export function RealTerminal({
  workingDirectory,
  shellId,
  slot,
  slotsVersion,
}: RealTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const openedRef = useRef(false);

  // Create the persistent container div once
  if (!containerRef.current && typeof document !== "undefined") {
    const el = document.createElement("div");
    el.style.height = "100%";
    el.style.width = "100%";
    el.style.background = NEXUS_TERMINAL_THEME.background!;
    containerRef.current = el;
  }

  // Mount: init xterm once, open on first real parent, init WS once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      fontFamily: NEXUS_TERMINAL_FONT,
      fontWeight: "400",
      fontWeightBold: "600",
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      theme: NEXUS_TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    const tryOpen = () => {
      if (openedRef.current) return;
      if (!container.isConnected) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      term.open(container);
      openedRef.current = true;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // webgl unsupported; fall back to canvas
      }
      try {
        fit.fit();
      } catch {
        // ignore
      }
    };

    tryOpen();

    const decoder = new TextDecoder();

    const sendResize = (cols: number, rows: number) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };

    let cancelled = false;

    // The pty server port is per-instance (web 3002, desktop dev 3102, …) so we
    // discover it at runtime instead of hardcoding. Falls back to a port derived
    // from the page port if the endpoint is unreachable.
    const connect = async () => {
      let port = 3002;
      try {
        const res = await fetch("/api/terminal/info", { cache: "no-store" });
        if (res.ok) {
          const info = (await res.json()) as { port?: number };
          if (Number.isFinite(info.port)) port = Number(info.port);
        }
      } catch {
        // Dev-only heuristic (web 3000→3002, native 3100→3102). Nexus hosts
        // serve on 3030 but keep the terminal on 3002, so don't apply it there.
        const pagePort = Number(window.location.port);
        if (pagePort === 3000 || pagePort === 3100) port = pagePort + 2;
      }
      if (cancelled) return;

      // Same host as the page: a remote nexus host serves its own terminal
      // server next to the app, so hardcoding localhost would silently open a
      // pty on the viewer's machine instead.
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = new URL(`${wsProtocol}//${window.location.hostname}:${port}`);
      if (workingDirectory) wsUrl.searchParams.set("cwd", workingDirectory);
      if (shellId) wsUrl.searchParams.set("shell", shellId);
      const initialCols = Math.max(term.cols || 80, 80);
      const initialRows = Math.max(term.rows || 24, 24);
      wsUrl.searchParams.set("cols", String(initialCols));
      wsUrl.searchParams.set("rows", String(initialRows));

      const ws = new WebSocket(wsUrl.toString());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : decoder.decode(new Uint8Array(event.data as ArrayBuffer));
        term.write(data);
      };

      ws.onclose = () => {
        term.writeln("\r\n\x1b[31m[Disconnected]\x1b[0m");
      };

      ws.onerror = () => {
        term.writeln("\r\n\x1b[31m[Connection error]\x1b[0m");
      };
    };

    void connect();

    const dataDisp = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      sendResize(cols, rows);
    });

    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      tryOpen();
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        try {
          fit.fit();
        } catch {
          // ignore
        }
      });
    });
    ro.observe(container);

    return () => {
      cancelled = true;
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      dataDisp.dispose();
      resizeDisp.dispose();
      const ws = wsRef.current;
      if (ws) {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.addEventListener("open", () => ws.close());
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
      openedRef.current = false;
      if (container.parentElement) container.parentElement.removeChild(container);
    };
    // run once for this component instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reparent on slot changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const target = slot ?? fallbackRef.current;
    if (!target) return;
    if (container.parentElement !== target) {
      target.appendChild(container);
    }
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
      termRef.current?.focus();
    });
  }, [slot, slotsVersion]);

  // When no slot prop is provided, anchor here so component behaves like before
  if (slot === undefined) {
    return <div ref={fallbackRef} className="h-full w-full bg-[#040609]" />;
  }
  return null;
}
