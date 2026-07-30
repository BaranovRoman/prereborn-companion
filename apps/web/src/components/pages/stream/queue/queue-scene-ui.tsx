"use client";

import Image from "next/image";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import { useAccountMatches } from "@/entities/stream-session/lib/use-account-matches";
import { useOverlayPolling } from "@/entities/stream-session/lib/use-overlay-polling";
import type { OverlayData, StreamMatch } from "@/entities/stream-session/model/types";
import { useSteamIntegration } from "@/entities/steam-integration/lib/use-steam-integration";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { useQueueSettings } from "@/entities/stream-queue-settings/lib/use-queue-settings";
import { useTwitchIntegration } from "@/entities/twitch-integration/lib/use-twitch-integration";
import { useDonationAlertsIntegration } from "@/entities/donation-alerts-integration/lib/use-donation-alerts-integration";
import type { DonationAlertsIntegrationStatus } from "@/entities/donation-alerts-integration/model/types";
import type { TwitchIntegrationStatus } from "@/entities/twitch-integration/model/types";
import type { SteamIntegrationStatus } from "@/entities/steam-integration/model/types";
import type { QueueChannelGoal } from "@/entities/stream-queue-settings/model/types";
import styles from "./queue-scene.module.scss";

const EMPTY_VALUE = "—";

const DONATION_RANKS = [
    { min: 5_620, tier: 8, name: "Immortal", stars: 0 },
    ...[
        { tier: 7, name: "Divine", thresholds: [4_620, 4_820, 5_020, 5_220, 5_420] },
        { tier: 6, name: "Ancient", thresholds: [3_850, 4_004, 4_158, 4_312, 4_466] },
        { tier: 5, name: "Legend", thresholds: [3_080, 3_234, 3_388, 3_542, 3_696] },
        { tier: 4, name: "Archon", thresholds: [2_310, 2_464, 2_618, 2_772, 2_926] },
        { tier: 3, name: "Crusader", thresholds: [1_540, 1_694, 1_848, 2_002, 2_156] },
        { tier: 2, name: "Guardian", thresholds: [770, 924, 1_078, 1_232, 1_386] },
        { tier: 1, name: "Herald", thresholds: [0, 154, 308, 462, 616] },
    ].flatMap(({ tier, name, thresholds }) =>
        thresholds.map((min, index) => ({ min, tier, name, stars: index + 1 }))
    ),
].sort((a, b) => b.min - a.min);

const getDonationRank = (amount: number) =>
    DONATION_RANKS.find((rank) => amount >= rank.min) ?? DONATION_RANKS.at(-1)!;

const subscribeToHostname = () => () => {};
const getHostname = () => window.location.hostname;
const getServerHostname = () => "";

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
    <section className={`${styles.panel} ${className}`} aria-label={title}>
        <div className={styles.panelTitle}>
            <span>{title}</span>
        </div>
        {children}
    </section>
);

const PreloadedVideo = ({
    src,
    poster,
    className,
}: {
    src: string;
    poster?: string;
    className: string;
}) => {
    const [ready, setReady] = useState(false);

    return (
        <>
            {poster && (
                <img
                    className={`${className} ${styles.videoPosterLayer}`}
                    src={poster}
                    alt=""
                    aria-hidden="true"
                />
            )}
            <video
                className={`${className} ${styles.videoPlaybackLayer}`}
                src={src}
                poster={poster}
                preload="auto"
                autoPlay
                loop
                muted
                playsInline
                onLoadedData={() => setReady(true)}
                onCanPlay={() => setReady(true)}
                onPlaying={() => setReady(true)}
                onWaiting={() => setReady(false)}
                onStalled={() => setReady(false)}
                onError={() => setReady(false)}
                style={{
                    opacity: ready ? 1 : 0,
                    transition: "opacity 220ms ease",
                }}
            />
        </>
    );
};

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
    steamProfile: SteamIntegrationStatus["profile"];
    twitch: TwitchIntegrationStatus | null;
    donationAlerts: DonationAlertsIntegrationStatus | null;
    webcamImageUrl: string | null;
    channelGoal: QueueChannelGoal;
}

interface GsiItem {
    name: string;
    displayName: string;
    imageUrl: string;
}

const INVENTORY_SLOT_COUNT = 9;
const MAIN_INVENTORY_SLOT_COUNT = 6;
const MANTLE_PLACEHOLDER: GsiItem = {
    name: "item_mantle",
    displayName: "mantle of intelligence",
    imageUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/mantle.png",
};

const getMatchItems = (inventory: Array<string | null> | undefined): Array<GsiItem | null> => {
    if (!inventory) return [];
    return Array.from({ length: INVENTORY_SLOT_COUNT }, (_, index) => {
        const name = inventory[index];
        if (!name || !name.startsWith("item_") || name === "item_empty") return null;
        const assetName = name.slice("item_".length);
        return {
            name,
            displayName: assetName.replaceAll("_", " "),
            imageUrl: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/${assetName}.png`,
        };
    });
};

const PlayerProfile = ({
    rating,
    wins,
    losses,
    steamProfile,
}: QueueDataProps) => {
    const accountName = steamProfile?.displayName || "STREAMER";
    const initials = accountName.slice(0, 2).toUpperCase();
    const total = wins + losses;
    const winRate = total ? Math.round((wins / total) * 100) : 0;

    return (
        <Panel title="Player record" className={styles.playerProfile}>
            <div className={styles.profileBody}>
                {steamProfile?.avatarUrl ? (
                    <img className={styles.avatarImage} src={steamProfile.avatarUrl} alt="" />
                ) : (
                    <div className={styles.avatar}>{initials}</div>
                )}
                <div className={styles.playerIdentity}>
                    <span className={styles.overline}>STEAM PLAYER</span>
                    <strong>{accountName.toUpperCase()}</strong>
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
    const recordedItems = getMatchItems(match?.inventory);
    const matchItems = recordedItems.some(Boolean)
        ? recordedItems
        : Array.from({ length: INVENTORY_SLOT_COUNT }, () => MANTLE_PLACEHOLDER);
    const mainItems = matchItems.slice(0, MAIN_INVENTORY_SLOT_COUNT);
    const backpackItems = matchItems.slice(MAIN_INVENTORY_SLOT_COUNT);

    const renderItem = (item: GsiItem | null, index: number) => (
        <span
            key={index}
            className={styles.item}
            data-empty={item ? undefined : "true"}
            title={item?.displayName}
        >
            {item ? <img src={item.imageUrl} alt={item.displayName} /> : null}
        </span>
    );

    return (
        <Panel title="Last match // Featured hero" className={styles.featuredMatch}>
            <div className={styles.heroArt} aria-label={hero?.localizedName ?? "No match data"}>
                {hero ? (
                    <PreloadedVideo
                        className={styles.featuredHeroImage}
                        src={hero.featuredVideoUrl}
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
                        ? `MATCH ${match.dotaMatchId ?? "UNKNOWN"} // ${match.gameMode.toUpperCase()} // ${formatDate(match.endedAt)}`
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
                <div className={styles.inventory} aria-label="Last recorded inventory">
                    <div className={styles.items} aria-label="Main inventory">
                        {mainItems.map(renderItem)}
                    </div>
                    <div className={styles.backpackItems} aria-label="Backpack">
                        {backpackItems.map((item, index) =>
                            renderItem(item, index + MAIN_INVENTORY_SLOT_COUNT)
                        )}
                    </div>
                </div>
            </div>
        </Panel>
    );
};

const WebcamSlot = ({ webcamImageUrl }: QueueDataProps) => (
    <Panel title="Live capture" className={styles.webcamPanel}>
        <div
            className={styles.webcam}
            data-testid="webcam-slot"
            data-has-image={Boolean(webcamImageUrl)}
        >
            {webcamImageUrl ? (
                <img src={webcamImageUrl} alt="" />
            ) : (
                <><span>WEBCAM</span><small>EXTERNAL OBS SOURCE</small></>
            )}
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
                {favorites.length ? favorites.map(([heroId]) => {
                    const hero = getHeroById(heroId);
                    return (
                        <div key={heroId} className={styles.favorite}>
                            <div className={styles.favoritePortrait}>
                                {hero ? (
                                    <PreloadedVideo
                                        src={hero.favoriteVideoUrl}
                                        className=""
                                    />
                                ) : (
                                    <span>?</span>
                                )}
                                {hero && (
                                    <img
                                        className={styles.attributeIcon}
                                        src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_${hero.attribute}.png`}
                                        alt=""
                                    />
                                )}
                            </div>
                            <div className={styles.favoriteCaption}>
                                <b>{hero?.localizedName ?? `Hero ${heroId}`}</b>
                            </div>
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
                const result = resultLabel(match);
                return (
                    <div key={match.id} className={styles.gameRow}>
                        {hero ? (
                            <img className={styles.gameHeroImage} src={hero.imageUrl} alt="" />
                        ) : (
                            <span className={styles.gameMark}>?</span>
                        )}
                        <div><b>{hero?.localizedName.toUpperCase() ?? `HERO ${match.heroId}`}</b><small>KDA {match.kills}/{match.deaths}/{match.assists}</small></div>
                        <em data-result={result}>{result}</em>
                        <strong data-positive={Boolean(match.ratingDelta && match.ratingDelta > 0)}>
                            ({formatDelta(match.ratingDelta)})
                        </strong>
                        <time>{formatDate(match.endedAt)}</time>
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
    channelGoal,
    rating,
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
                    <span className={styles.goalTrack}>
                        <i
                            style={{
                                width: channelGoal.type === "none"
                                    ? (steamConnected ? "100%" : "18%")
                                    : `${Math.max(0, Math.min(100, (((channelGoal.type === "rating" ? rating ?? channelGoal.startValue : channelGoal.startValue) - channelGoal.startValue) / Math.max(1, channelGoal.targetValue - channelGoal.startValue)) * 100))}%`,
                            }}
                        />
                        <span className={styles.goalMeta}>
                            <span>{channelGoal.type === "none" ? "STEAM SYNC" : channelGoal.label || "CHANNEL GOAL"}</span>
                            <b>
                                {channelGoal.type === "none"
                                    ? steamSyncStatus?.replaceAll("_", " ").toUpperCase() ?? (steamConnected ? "READY" : "NOT CONNECTED")
                                    : `${channelGoal.type === "rating" ? formatRating(rating) : channelGoal.startValue} / ${channelGoal.targetValue}`}
                            </b>
                        </span>
                    </span>
                </div>
            </div>
        </Panel>
    );
};

const TwitchChat = ({ twitch }: QueueDataProps) => {
    const parent = useSyncExternalStore(subscribeToHostname, getHostname, getServerHostname);
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
                    <i aria-hidden="true">T</i>
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

const DonationTop = ({ donationAlerts }: QueueDataProps) => {
    const leaders = (donationAlerts?.topDonors ?? []).slice(0, 9);
    return (
        <Panel title="Supporters // Online" className={styles.donationPanel}>
            {leaders.length ? (
                <div className={styles.donationTop}>
                    {leaders.map((leader) => {
                        const rank = getDonationRank(leader.amount);
                        const rankLabel = rank.stars
                            ? `${rank.name} ${"★".repeat(rank.stars)}`
                            : rank.name;
                        return (
                            <div
                                key={`${leader.username}-${leader.currency}`}
                                className={styles.donationFriend}
                                title={`${rankLabel}: от ${rank.min.toLocaleString("ru-RU")} ${leader.currency}`}
                            >
                                <Image
                                    src={`/vendor/opendota/rank-icons/rank_icon_${rank.tier}.png`}
                                    alt={`${rankLabel} medal`}
                                    width={42}
                                    height={42}
                                />
                                <p>
                                    <strong>{leader.username}</strong>
                                    <small>{rankLabel}</small>
                                </p>
                                <b>
                                    {new Intl.NumberFormat("ru-RU").format(leader.amount)}
                                    <em>{leader.currency}</em>
                                </b>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className={styles.donationEmpty}>
                    {donationAlerts?.connected ? "NO DONATIONS YET" : "CONNECT DONATIONALERTS"}
                </div>
            )}
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
        { mark: "C", name: "Companion", status: companionOnline ? "ONLINE" : "OFFLINE", active: companionOnline },
        { mark: "S", name: "Steam", status: steamConnected ? "CONNECTED" : "NOT CONNECTED", active: steamConnected },
        { mark: "M", name: "Mode", status: gameMode?.toUpperCase() ?? "UNKNOWN", active: Boolean(gameMode) },
        { mark: "G", name: "Games", status: `${matches.length} RECORDED`, active: matches.length > 0 },
    ];
    return (
        <Panel title="System // Live status" className={styles.supporters}>
            <div className={styles.supporterGrid}>
                {statuses.map(({ mark, name, status, active }) => (
                    <div key={name} data-active={active}>
                        <span>{mark}</span>
                        <p><b>{name}</b><small>{status}</small></p>
                    </div>
                ))}
            </div>
        </Panel>
    );
};

export const QueueSceneUi = ({ publicData }: { publicData?: OverlayData }) => {
    const { user } = useStreamSession();
    const { matches } = useAccountMatches();
    const steam = useSteamIntegration();
    const queueSettings = useQueueSettings();
    const twitch = useTwitchIntegration();
    const donationAlerts = useDonationAlertsIntegration();
    const overlay = useOverlayPolling(user?.publicToken ?? "", null);
    const activeOverlay = publicData ?? overlay;
    const activeSettings = publicData?.queueSettings ?? queueSettings.settings;
    const realMatches = activeOverlay?.matches ?? matches ?? [];
    const data: QueueDataProps = {
        email: user?.email ?? null,
        gameMode: user?.gameMode ?? activeOverlay?.gameMode ?? null,
        rating: activeOverlay?.rating,
        wins: activeOverlay?.wins ?? 0,
        losses: activeOverlay?.losses ?? 0,
        matches: realMatches,
        companionOnline: activeOverlay?.companion.isOnline ?? false,
        steamConnected: publicData?.steam.connected ?? steam.status?.connected ?? false,
        steamId: steam.status?.steamId64,
        steamSyncStatus: steam.status?.lastSyncStatus,
        steamProfile: publicData?.steam.profile ?? steam.status?.profile,
        twitch: twitch.status,
        donationAlerts: donationAlerts.status,
        webcamImageUrl: activeSettings.webcamImageUrl,
        channelGoal: activeSettings.channelGoal,
    };
    const visibility = activeSettings.visibility;
    const topCount = Number(visibility.playerProfile) + Number(visibility.streamProfile);
    const sideCount = Number(visibility.webcam) + Number(visibility.favoriteHeroes) + Number(visibility.recentGames);

    return (
        <div className={styles.interface}>
            <header className={styles.topBar}>
                <Image className={styles.brandLogo} src="/logo.png" width={52} height={52} alt="PreReborn Companion" priority />
                <div className={styles.brand}><strong>PREREBORN</strong><span>COMPANION</span></div>
                <div className={styles.navOrnaments}><span>PROFILE</span><span>HEROES</span><span>HISTORY</span><span>STATUS</span></div>
                <div className={styles.broadcast}><i data-online={data.companionOnline} /> {data.companionOnline ? "LIVE DATA" : "WAITING FOR COMPANION"}</div>
            </header>
            <div className={styles.dashboard} data-top-count={topCount}>
                {visibility.playerProfile && <PlayerProfile {...data} />}
                {visibility.streamProfile && <StreamProfile {...data} />}
                {(visibility.featuredMatch || sideCount > 0) && <div className={styles.leftMain} data-featured={visibility.featuredMatch}>
                    {visibility.featuredMatch && <FeaturedMatch {...data} />}
                    {sideCount > 0 && <div className={styles.sideStack} data-widget-count={sideCount}>
                        {visibility.webcam && <WebcamSlot {...data} />}
                        {visibility.favoriteHeroes && (
                            <FavoriteHeroes {...data} selectedHeroIds={activeSettings.favoriteHeroIds} />
                        )}
                        {visibility.recentGames && <RecentGames {...data} />}
                    </div>}
                </div>}
                {visibility.twitchChat && (
                    <div className={styles.rightMain}>
                        <TwitchChat {...data} />
                        <DonationTop {...data} />
                    </div>
                )}
            </div>
            <footer className={styles.sceneFooter}>
                <span>{`${data.steamConnected ? "STEAM CONNECTED" : "STEAM OFFLINE"} // ${data.matches.length} MATCHES LOADED`}</span>
                <span>PREREBORN COMPANION // OBS SCENE</span>
            </footer>
        </div>
    );
};
