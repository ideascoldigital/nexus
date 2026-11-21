import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { NativeMenuGuard } from "@/components/layout/native-menu-guard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryProvider } from "@/providers/query-provider";
import { Toaster } from "@/components/ui/toaster";
import { APPEARANCE_BOOT_SCRIPT } from "@/lib/appearance";
import "./globals.css";

// Inter for display/UI, JetBrains Mono for labels, code and terminal.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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
            {children}
            <Toaster />
          </TooltipProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
