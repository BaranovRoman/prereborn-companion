import { redirect } from "next/navigation";
import { toAccountUrl, type LegacySearchParams } from "@/components/pages/account/legacy-redirect";

// WK-189 - legacy cabinet address, see legacy-redirect.ts.
export default async function Stream({ searchParams }: { searchParams: Promise<LegacySearchParams> }) {
  redirect(toAccountUrl(await searchParams));
}
