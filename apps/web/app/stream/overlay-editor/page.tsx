import { redirect } from "next/navigation";

// WK-189 - overlay layout is edited in the Dota 2 plugin inside Companion.
export default function StreamOverlayEditor() {
  redirect("/account");
}
