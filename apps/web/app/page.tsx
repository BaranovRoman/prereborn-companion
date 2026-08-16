import type { Metadata } from "next";
import { LandingPage } from "@/components/pages/landing";
export const metadata: Metadata = { title: "Dota 2 Stream Companion и OBS Overlay", description: "PreReborn связывает Dota 2, Companion, stream overlay и OBS automation для стримеров.", robots: { index: true, follow: true }, openGraph: { title: "PreReborn Companion", description: "Dota 2 stream overlay, anti-snipe и OBS automation.", type: "website" } };
export default function HomePage(){return <LandingPage/>}

