// @novnc/novnc ships no types (1.7.0, MPL-2.0). Only the surface the browser
// tab uses is declared — a hand-written .d.ts that claimed the whole API would
// drift from the package without anything catching it.
declare module "@novnc/novnc" {
  export interface RFBOptions {
    /** VNC password. The protocol truncates it to 8 bytes. */
    credentials?: { username?: string; password?: string; target?: string };
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RFBOptions,
    );

    /** Scale the framebuffer to the container instead of clipping it. */
    scaleViewport: boolean;
    /** Ask the server to resize the session to the container's size. */
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;

    focus(): void;
    blur(): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
    machineReboot(): void;
    clipboardPasteFrom(text: string): void;
  }
}
