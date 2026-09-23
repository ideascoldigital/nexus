"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { NAV_ITEMS } from "@/components/layout/nav-items";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * The workspace's destinations, on a phone.
 *
 * The sidebar is `hidden md:flex`, so below that width its links were present
 * in the DOM and invisible with nothing else offering them: you landed on a
 * page and stayed on it. This is the way out — the same list, from the header,
 * which is the one element present on every screen.
 *
 * Hidden at md and up, where the sidebar itself is back and a second copy of
 * the same navigation would just be clutter.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* The trigger renders its own button (Base UI), so the classes go
          straight on it rather than through asChild. */}
      <SheetTrigger
        aria-label="Open navigation"
        className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:hidden"
      >
        <Menu className="h-[18px] w-[18px]" />
      </SheetTrigger>

      <SheetContent side="left" className="w-[260px] p-0">
        <SheetHeader className="border-b border-border/60 px-4 py-3">
          <SheetTitle className="text-sm">Navigate</SheetTitle>
        </SheetHeader>

        <nav className="flex flex-col gap-0.5 p-2">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                // Closing on navigate: a sheet left open over the page it just
                // opened is a second tap for something the user already did.
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
