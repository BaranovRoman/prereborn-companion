import type { Metadata } from "next";
import { Suspense } from "react";
import { StreamLoginPage } from "@/components/pages/stream/login";

export const metadata: Metadata = {
    title: "Вход — Stream",
    robots: { index: false, follow: false },
};

export default function StreamLogin() {
    return <Suspense fallback={null}><StreamLoginPage /></Suspense>;
}
