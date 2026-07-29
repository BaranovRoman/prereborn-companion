"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import { useAccountMatches } from "@/entities/stream-session/lib/use-account-matches";
import { useOverlayPolling } from "@/entities/stream-session/lib/use-overlay-polling";
import type { StreamMatch } from "@/entities/stream-session/model/types";
import { useSteamIntegration } from "@/entities/steam-integration/lib/use-steam-integration";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { useQueueSettings } from "@/entities/stream-queue-settings/lib/use-queue-settings";
import { useTwitchIntegration } from "@/entities/twitch-integration/lib/use-twitch-integration";
import type { TwitchIntegrationStatus } from "@/entities/twitch-integration/model/types";
import styles from "./queue-scene.module.scss";

const EMPTY_VALUE = "—";

const formatRating = (rating: number | null | undefined) =>
    rating === null || rating === undefined
        ? EMPTY_VALUE
        : new Intl.NumberFormat("en-US").format(rating);

const formatDelta = (delta: number | null) =>
    delta === null ? EMPTY_VALUE : `${delta > 0 ? "+" : ""}${delta}`;

const formatDate = (date: string | null) =>
    date
        ? new Intl.DateTimeFormat("ru-RU", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
          }).format(new Date(date))
        : EMPTY_VALUE;

const resultLabel = (match: StreamMatch) => {
    if (match.result === "win") return "VICTORY";
    if (match.result === "loss") return "DEFEAT";
    if (match.result === "abandon") return "ABANDON";
    return "UNKNOWN";
};

const shortResult = (match: StreamMatch) => {
    if (match.result === "win") return "W";
    if (match.result === "loss") return "L";
    if (match.result === "abandon") return "A";
    return "—";
};

const Panel = ({
    title,
    className = "",
    children,
}: {
    title: string;
    className?: string;
    children: React.ReactNode;
}) => (
    <section className={`${styles.panel} ${className}`}>
        <div className={styles.panelTitle}>
            <span>{title}</span>
        </div>
        {children}
    </section>
);

const HiddenSlot = () => <div className={styles.hiddenSlot} aria-hidden="true" />;

interface QueueDataProps {
    email: string | null;
    gameMode: "ranked" | "unranked" | null;
    rating: number | null | undefined;
    wins: number;
    losses: number;
    matches: StreamMatch[];
    companionOnline: boolean;
    steamConnected: boolean;
    steamId: string | undefined;
    steamSyncStatus: string | null | undefined;
    twitch: TwitchIntegrationStatus | null;
}

const PlayerProfile = ({
    email,
    gameMode,
    rating,
    wins,
    losses,
}: QueueDataProps) => {
    const accountName = email?.split("@")[0] || "STREAMER";
    const initials = accountName.slice(0, 2).toUpperCase();
    const total = wins + losses;
    const winRate = total ? Math.round((wins / total) * 100) : 0;

    return (
        <Panel title="Player record" className={styles.playerProfile}>
            <div className={styles.profileBody}>
                <div className={styles.avatar}>{initials}</div>
                <div className={styles.playerIdentity}>
                    <span className={styles.overline}>STREAM ACCOUNT // LIVE DATA</span>
                    <strong>{accountName.toUpperCase()}</strong>
                    <span>{gameMode === "ranked" ? "Ranked session" : "Unranked session"}</span>
                </div>
                <div className={styles.profileStats}>
                    <div><span>RATING</span><b>{formatRating(rating)}</b></div>
                    <div><span>STREAM</span><b>{wins}–{losses}</b></div>
                    <div><span>WIN RATE</span><b>{total ? `${winRate}%` : EMPTY_VALUE}</b></div>
                </div>
            </div>
        </Panel>
    );
};

const FeaturedMatch = ({ matches }: QueueDataProps) => {
    const match = matches[0];
    const hero = match ? getHeroById(match.heroId) : undefined;

    return (
        <Panel title="Last match // Featured hero" className={styles.featuredMatch}>
            <div className={styles.heroArt} aria-label={hero?.localizedName ?? "No match data"}>
                {hero ? (
                    <video
                        className={styles.featuredHeroImage}
                        src={hero.videoUrl}
                        poster={hero.imageUrl}
                        autoPlay
                        loop
                        muted
                        playsInline
                    />
                ) : (
                    <>
                        <span className={styles.heroSigil}>?</span>
                        <span className={styles.heroSilhouette} />
                    </>
                )}
                <span className={styles.heroMist} />
            </div>
            <div className={styles.heroDetails}>
                <span className={styles.overline}>
                    {match
                        ? `${match.gameMode.toUpperCase()} // ${formatDate(match.endedAt)}`
                        : "MATCH DATA // WAITING"}
                </span>
                <div className={styles.heroNameRow}>
                    <strong>{hero?.localizedName ?? "No completed matches"}</strong>
                    <em data-result={match?.result ?? undefined}>
                        {match ? resultLabel(match) : "NO DATA"}
                    </em>
                </div>
                <div className={styles.matchStats}>
                    <div>
                        <span>K / D / A</span>
                        <b>{match ? `${match.kills} / ${match.deaths} / ${match.assists}` : EMPTY_VALUE}</b>
                    </div>
                    <div><span>MODE</span><b>{match?.gameMode.toUpperCase() ?? EMPTY_VALUE}</b></div>
                    <div>
                        <span>RATING</span>
                        <b className={match?.ratingDelta && match.ratingDelta > 0 ? styles.positive : undefined}>
                            {match ? formatDelta(match.ratingDelta) : EMPTY_VALUE}
                        </b>
                    </div>
                </div>
                <div className={styles.items} aria-label="Recorded match metadata">
                    {match ? (
                        [
                            `HERO ${match.heroId}`,
                            "FINAL",
                            match.result?.toUpperCase() ?? "UNKNOWN",
                            match.gameMode.toUpperCase(),
                            match.ratingBefore === null ? "MMR —" : `${match.ratingBefore}`,
                            match.ratingAfter === null ? "AFTER —" : `${match.ratingAfter}`,
                        ].map((item, index) => (
                            <span key={`${item}-${index}`} className={styles.item} data-tone={index % 3}>{item}</span>
                        ))
                    ) : (
                        <span className={styles.matchDataEmpty}>Waiting for the first completed match</span>
                    )}
                </div>
            </div>
        </Panel>
    );
};

const WebcamSlot = () => (
    <Panel title="Live capture" className={styles.webcamPanel}>
        <div className={styles.webcam} data-testid="webcam-slot">
            <span>WEBCAM</span><small>EXTERNAL OBS SOURCE</small>
        </div>
    </Panel>
);

const FavoriteHeroes = ({
    matches,
    selectedHeroIds,
}: QueueDataProps & { selectedHeroIds: number[] }) => {
    const allMatchCounts = matches.reduce((counts, match) => {
        counts.set(match.heroId, (counts.get(match.heroId) ?? 0) + 1);
        return counts;
    }, new Map<number, number>());
    const automaticFavorites = [...allMatchCounts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
    const favorites: Array<[number, number]> = selectedHeroIds.length
        ? selectedHeroIds.map((heroId) => [heroId, allMatchCounts.get(heroId) ?? 0])
        : automaticFavorites;

    return (
        <Panel title="Favorite heroes" className={styles.favorites}>
            <div className={styles.favoriteList}>
                {favorites.length ? favorites.map(([heroId, games], index) => {
                    const hero = getHeroById(heroId);
                    return (
                        <div key={heroId} className={styles.favorite}>
                            {hero ? (
                                <video className={styles.miniHeroImage} src={hero.videoUrl} poster={hero.imageUrl} autoPlay loop muted playsInline />
                            ) : (
                                <span className={styles.miniPortrait}>?</span>
                            )}
                            <div><b>{hero?.localizedName ?? `Hero ${heroId}`}</b><small>{games ? `${games} matches` : "Selected hero"}</small></div>
                            <em>0{index + 1}</em>
                        </div>
                    );
                }) : (
                    <div className={styles.panelEmpty}>No match history yet</div>
                )}
            </div>
        </Panel>
    );
};

const RecentGames = ({ matches }: QueueDataProps) => (
    <Panel title="Recent games" className={styles.recentGames}>
        <div className={styles.gamesList}>
            {matches.length ? matches.slice(0, 5).map((match) => {
                const hero = getHeroById(match.heroId);
                const result = shortResult(match);
                return (
                    <div key={match.id} className={styles.gameRow}>
                        {hero ? (
                            <img className={styles.gameHeroImage} src={hero.imageUrl} alt="" />
                        ) : (
                            <span className={styles.gameMark}>?</span>
                        )}
                        <div><b>{hero?.localizedName.toUpperCase() ?? `HERO ${match.heroId}`}</b><small>{match.kills}/{match.deaths}/{match.assists}</small></div>
                        <em data-result={result}>{result}</em>
                        <strong>{formatDelta(match.ratingDelta)}</strong>
                    </div>
                );
            }) : (
                <div className={styles.panelEmpty}>No completed matches</div>
            )}
        </div>
    </Panel>
);

const StreamProfile = ({
    email,
    companionOnline,
    steamConnected,
    steamId,
    steamSyncStatus,
    twitch,
}: QueueDataProps) => {
    const accountName = twitch?.displayName || twitch?.login || email?.split("@")[0] || "stream account";
    const initials = accountName.slice(0, 2).toUpperCase();
    return (
        <Panel title="Channel transmission" className={styles.streamProfile}>
            <div className={styles.streamProfileBody}>
                {twitch?.profileImageUrl ? (
                    <img className={styles.twitchAvatarImage} src={twitch.profileImageUrl} alt="" />
                ) : <span className={styles.twitchAvatar}>{initials}</span>}
                <div>
                    <span className={styles.overline}>{twitch?.connected ? "TWITCH CHANNEL" : "PREREBORN STREAM"}</span>
                    <strong>{accountName}</strong>
                    <small>{twitch?.live ? twitch.live.title : (steamConnected ? `Steam ${steamId ?? "connected"}` : "Steam not connected")}</small>
                </div>
                <div className={styles.liveBadge}><i data-online={Boolean(twitch?.live)} /> {twitch?.live ? `${twitch.live.viewerCount} LIVE` : "OFFLINE"}</div>
                <div className={styles.goal}>
                    <div><span>STEAM SYNC</span><b>{steamSyncStatus?.replaceAll("_", " ").toUpperCase() ?? (steamConnected ? "READY" : "NOT CONNECTED")}</b></div>
                    <span className={styles.goalTrack}><i data-connected={steamConnected} /></span>
                </div>
            </div>
        </Panel>
    );
};

const TwitchChat = ({ twitch }: QueueDataProps) => {
    const [parent, setParent] = useState("");
    useEffect(() => setParent(window.location.hostname), []);
    return (
        <Panel title="Twitch chat" className={styles.chatPanel}>
            {twitch?.connected && twitch.login && parent ? (
                <iframe
                    className={styles.twitchChatEmbed}
                    src={`https://www.twitch.tv/embed/${encodeURIComponent(twitch.login)}/chat?parent=${encodeURIComponent(parent)}&darkpopout`}
                    title={`Twitch chat — ${twitch.displayName || twitch.login}`}
                />
            ) : (
                <div className={`${styles.chatBody} ${styles.chatUnavailable}`}>
                    <strong>TWITCH CHAT IS NOT CONNECTED</strong>
                    <span>Connect Twitch in the stream dashboard integrations.</span>
                </div>
            )}
            <div className={styles.chatFooter}>
                CHANNEL CHAT // {twitch?.connected ? twitch.login?.toUpperCase() : "NO DATA SOURCE"}
            </div>
        </Panel>
    );
};

const SystemStatus = ({
    gameMode,
    companionOnline,
    steamConnected,
    matches,
}: QueueDataProps) => {
    const statuses = [
        ["C", "Companion", companionOnline ? "ONLINE" : "OFFLINE"],
        ["S", "Steam", steamConnected ? "CONNECTED" : "NOT CONNECTED"],
        ["M", "Mode", gameMode?.toUpperCase() ?? "UNKNOWN"],
        ["G", "Games", `${matches.length} RECORDED`],
    ];
    return (
        <Panel title="System // Live status" className={styles.supporters}>
            <div className={styles.supporterGrid}>
                {statuses.map(([mark, name, status]) => (
                    <div key={name}><span>{mark}</span><p><b>{name}</b><small>{status}</small></p></div>
                ))}
            </div>
        </Panel>
    );
};

export const QueueSceneUi = () => {
    const { user } = useStreamSession();
    const { matches } = useAccountMatches();
    const steam = useSteamIntegration();
    const queueSettings = useQueueSettings();
    const twitch = useTwitchIntegration();
    const overlay = useOverlayPolling(user?.publicToken ?? "", null);
    const realMatches = overlay?.matches ?? matches ?? [];
    const data: QueueDataProps = {
        email: user?.email ?? null,
        gameMode: user?.gameMode ?? overlay?.gameMode ?? null,
        rating: overlay?.rating,
        wins: overlay?.wins ?? 0,
        losses: overlay?.losses ?? 0,
        matches: realMatches,
        companionOnline: overlay?.companion.isOnline ?? false,
        steamConnected: steam.status?.connected ?? false,
        steamId: steam.status?.steamId64,
        steamSyncStatus: steam.status?.lastSyncStatus,
        twitch: twitch.status,
    };

    return (
        <div className={styles.interface}>
            <header className={styles.topBar}>
                <Image className={styles.brandLogo} src="/logo.png" width={52} height={52} alt="PreReborn Companion" priority />
                <div className={styles.brand}><strong>PREREBORN</strong><span>COMPANION</span></div>
                <div className={styles.navOrnaments}><span>PROFILE</span><span>HEROES</span><span>HISTORY</span><span>STATUS</span></div>
                <div className={styles.broadcast}><i data-online={data.companionOnline} /> {data.companionOnline ? "LIVE DATA" : "WAITING FOR COMPANION"}</div>
            </header>
            <div className={styles.dashboard}>
                {queueSettings.settings.visibility.playerProfile ? <PlayerProfile {...data} /> : <HiddenSlot />}
                {queueSettings.settings.visibility.streamProfile ? <StreamProfile {...data} /> : <HiddenSlot />}
                <div className={styles.leftMain}>
                    {queueSettings.settings.visibility.featuredMatch ? <FeaturedMatch {...data} /> : <HiddenSlot />}
                    <div className={styles.sideStack}>
                        {queueSettings.settings.visibility.webcam ? <WebcamSlot /> : <HiddenSlot />}
                        {queueSettings.settings.visibility.favoriteHeroes ? (
                            <FavoriteHeroes {...data} selectedHeroIds={queueSettings.settings.favoriteHeroIds} />
                        ) : <HiddenSlot />}
                        {queueSettings.settings.visibility.recentGames ? <RecentGames {...data} /> : <HiddenSlot />}
                    </div>
                </div>
                <div className={styles.rightMain}>
                    {queueSettings.settings.visibility.twitchChat ? <TwitchChat {...data} /> : <HiddenSlot />}
                    {queueSettings.settings.visibility.systemStatus ? <SystemStatus {...data} /> : <HiddenSlot />}
                </div>
            </div>
            <footer className={styles.sceneFooter}>
                <span>{data.steamConnected ? "STEAM CONNECTED" : "STEAM OFFLINE"} // {data.matches.length} MATCHES LOADED</span>
                <span>PREREBORN COMPANION // OBS SCENE</span>
            </footer>
        </div>
    );
};
