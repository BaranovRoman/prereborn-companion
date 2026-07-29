import type { Metadata } from "next";
import { StreamRegisterPage } from "@/components/pages/stream/register";

export const metadata: Metadata = {
    title: "Регистрация — Stream",
    robots: { index: false, follow: false },
};

export default function StreamRegister() {
    return <StreamRegisterPage />;
}
