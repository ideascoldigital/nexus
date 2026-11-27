import { redirect } from "next/navigation";

// The bots are the app (spec 39): Nexus opens on them, and the dashboard is
// one click away under /dashboard while each of its flows moves into chat.
export default function Home() {
  redirect("/bots");
}
