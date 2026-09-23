import {
  Bot,
  FolderKanban,
  Hash,
  LayoutDashboard,
  Settings,
} from "lucide-react";

/**
 * The workspace's top-level destinations.
 *
 * Shared by the sidebar and the phone menu rather than written twice: the
 * sidebar is `hidden md:flex`, so below that width these links were in the DOM
 * and invisible, with no other way to reach them — you landed on a page and
 * stayed there. A second copy of this list is a second place for that to
 * happen again.
 */
export const NAV_ITEMS = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/" },
  { icon: FolderKanban, label: "Projects", href: "/projects" },
  { icon: Bot, label: "Agents", href: "/agents" },
  { icon: Hash, label: "Skills", href: "/skills" },
  { icon: Settings, label: "Settings", href: "/settings" },
] as const;
