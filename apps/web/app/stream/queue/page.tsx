import type { Metadata } from "next";
import { QueueScene } from "@/components/pages/stream/queue/queue-scene";
import {
    parseQuality,
    parseSeed,
} from "@/components/pages/stream/queue/queue-scene-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Поиск матча — Stream",
    robots: { index: false, follow: false },
};

type QueueSearchParams = Record<string, string | string[] | undefined>;

const firstValue = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

interface QueueRouteProps {
    searchParams: Promise<QueueSearchParams>;
}

export default async function QueueRoute({ searchParams }: QueueRouteProps) {
    const query = await searchParams;

    return (
        <QueueScene
            quality={parseQuality(firstValue(query.quality))}
            seed={parseSeed(firstValue(query.seed))}
            debug={firstValue(query.debug) === "1"}
            forceFallback={firstValue(query.forceFallback) === "1"}
        />
    );
}
