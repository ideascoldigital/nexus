import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import { ExternalLinks } from "@/components/layout/external-links";
import { NativeMenuGuard } from "@/components/layout/native-menu-guard";
import { UpdateReadyNotice } from "@/components/layout/update-ready-notice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryProvider } from "@/providers/query-provider";
import { Toaster } from "@/components/ui/toaster";
import { APPEARANCE_BOOT_SCRIPT } from "@/lib/appearance";
import "./globals.css";

// Inter for display/UI, JetBrains Mono for labels, code and terminal — the
// latin variable cuts, which cover 400-700 in one file each.
//
// Served from this repo, not `next/font/google`: that fetched them from
// fonts.googleapis.com during `next build`, so a hiccup there failed the whole
// build — and it did, inside Docker, where the font loader's own parse of the
// reply threw `Cannot read properties of null` (release-image.yml run
// 45294050740). The build has no business depending on a third party at all.
// Updating a font means replacing its woff2; OFL texts sit beside them.
const inter = localFont({
  src: "./fonts/inter-latin-variable.woff2",
  variable: "--font-sans",
  weight: "400 700",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-variable.woff2",
  variable: "--font-mono",
  weight: "400 700",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nexus — AI Dev Orchestrator",
  description: "Orchestrate AI-powered software development from a single dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} dark h-full antialiased`}
      // The boot scripts below set data-layout, zoom, the theme class and data-titlebar before hydration;
      // React would otherwise warn that the attribute differs from what the server sent.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT_SCRIPT }} />
      </head>
      <body className="h-full bg-background text-foreground">
        {/* In the macOS desktop app the title bar is an overlay: the traffic
            lights sit inside the page, which leaves room for them and marks
            drag regions. Runs before hydration so nothing jumps. */}
        <Script id="titlebar-overlay" strategy="beforeInteractive">
          {`try{if("__TAURI_INTERNALS__" in window&&/Mac/.test(navigator.userAgent))document.documentElement.dataset.titlebar="overlay"}catch(e){}`}
        </Script>
        <QueryProvider>
          <TooltipProvider>
            <NativeMenuGuard />
            <ExternalLinks />
            {children}
            <UpdateReadyNotice />
            <Toaster />
          </TooltipProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
