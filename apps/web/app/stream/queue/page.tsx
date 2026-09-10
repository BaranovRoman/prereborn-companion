import type { Metadata } from "next";
import { QueueScene } from "@/components/pages/stream/queue/queue-scene";
import {
    parseQuality,
    parseSeed,
} from "@/components/pages/stream/queue/queue-scene-config";
import { MOCK_OVERLAY_DATA } from "@/components/pages/stream/queue/quiz/mock-overlay-data";

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
            // Phase 0 placement spike (WK-116) - `?mock=1` renders every
            // Between Matches widget with realistic populated content
            // instead of the empty/unauthenticated placeholder state, so
            // quiz-placement screenshots reflect real layout pressure. Dev/
            // e2e only - unreachable without the explicit query param.
            publicData={firstValue(query.mock) === "1" ? MOCK_OVERLAY_DATA : undefined}
        />
    );
}
