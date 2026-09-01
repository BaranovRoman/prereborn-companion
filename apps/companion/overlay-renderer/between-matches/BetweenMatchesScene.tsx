import { useState } from "react";
import { getHeroById } from "../../src/services/heroCatalog";
import logoUrl from "../../../web/public/logo-new.png";
import { Atmosphere } from "../Atmosphere";
import type { LocalMatchSummary, LocalSessionSummary, OverlayStateSnapshot, QueueSettings } from "../types";
import styles from "../../../web/src/components/pages/stream/queue/queue-scene.module.scss";
import parity from "./between-matches-parity.module.scss";

const EMPTY_VALUE = "—";
const INVENTORY_SLOTS = Array.from({ length: 9 }, (_, index) => index);
const communityMedals = import.meta.glob("../assets/rank-medals/*.png", { eager: true, import: "default" }) as Record<string, string>;
const donationRanks = [
  { min: 5_620, tier: 8, name: "Immortal", stars: 0 },
  ...[
    { tier: 7, name: "Divine", thresholds: [4_620, 4_820, 5_020, 5_220, 5_420] },
    { tier: 6, name: "Ancient", thresholds: [3_850, 4_004, 4_158, 4_312, 4_466] },
    { tier: 5, name: "Legend", thresholds: [3_080, 3_234, 3_388, 3_542, 3_696] },
    { tier: 4, name: "Archon", thresholds: [2_310, 2_464, 2_618, 2_772, 2_926] },
    { tier: 3, name: "Crusader", thresholds: [1_540, 1_694, 1_848, 2_002, 2_156] },
    { tier: 2, name: "Guardian", thresholds: [770, 924, 1_078, 1_232, 1_386] },
    { tier: 1, name: "Herald", thresholds: [0, 154, 308, 462, 616] },
  ].flatMap(({ tier, name, thresholds }) => thresholds.map((min, index) => ({ min, tier, name, stars: index + 1 }))),
].sort((left, right) => right.min - left.min);

const itemAsset = (name: string | null | undefined) => {
  if (!name?.startsWith("item_") || name === "item_empty") return null;
  const assetName = name.slice("item_".length);
  return {
    label: assetName.split("_").join(" "),
    url: assetName.startsWith("recipe_")
      ? `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/items/${assetName}_lg.png`
      : `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/${assetName}.png`,
  };
};

const resultLabel = (match: LocalMatchSummary) => {
  if (match.result === "win") return "VICTORY";
  if (match.result === "loss") return "DEFEAT";
  if (match.result === "abandon") return "ABANDON";
  return "UNKNOWN";
};

const ratingDelta = (match: LocalMatchSummary) =>
  match.ratingBefore === null || match.ratingAfter === null
    ? null
    : match.ratingAfter - match.ratingBefore;

const formatDelta = (value: number | null) =>
  value === null ? EMPTY_VALUE : `${value > 0 ? "+" : ""}${value}`;

const formatDate = (value: string | null) => {
  if (!value) return EMPTY_VALUE;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return EMPTY_VALUE;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

function Panel({ title, className = "", children }: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${styles.panel} ${className}`} aria-label={title}>
      <div className={`${styles.panelTitle} ${parity.panelTitle}`}><span>{title}</span></div>
      {children}
    </section>
  );
}

// Direct port of the production Queue scene's sticky poster/video hand-off:
// buffering must never turn a hero panel into a blank black rectangle.
function PreloadedVideo({ src, poster, className }: { src: string; poster: string; className: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const markReady = () => setStatus((previous) => previous === "failed" ? previous : "ready");
  return (
    <>
      {status !== "ready" && <img className={`${className} ${styles.videoPosterLayer}`} src={poster} alt="" />}
      <video
        className={`${className} ${styles.videoPlaybackLayer}`}
        src={src}
        poster={poster}
        preload="auto"
        autoPlay
        loop
        muted
        playsInline
        onLoadedData={markReady}
        onCanPlay={markReady}
        onPlaying={markReady}
        onError={() => setStatus("failed")}
        style={{ opacity: status === "ready" ? 1 : 0, transition: "opacity 220ms ease" }}
      />
    </>
  );
}

function PlayerProfile({ session, account, title = "PLAYER PROFILE" }: { session: LocalSessionSummary; account: OverlayStateSnapshot["account"]; title?: string }) {
  const total = session.wins + session.losses;
  const winRate = total ? Math.round((session.wins / total) * 100) : 0;
  const profile = account?.steam?.profile;
  const name = profile?.displayName || "STREAMER";
  return (
    <Panel title={title} className={styles.playerProfile}>
      <div className={styles.profileBody}>
        <div className={`${styles.profileBrand} ${parity.profileBrand}`}>
          <span><strong>PREREBORN</strong><small>Companion</small></span>
          <img src={logoUrl} alt="" />
        </div>
        <div className={styles.profileAvatarFrame}>{profile?.avatarUrl ? <img className={styles.avatarImage} src={profile.avatarUrl} alt="" /> : <div className={styles.avatar}>{name.slice(0, 2).toUpperCase()}</div>}</div>
        <div className={styles.playerIdentity}><strong>{name}</strong></div>
        <div className={`${styles.profileStats} ${parity.profileStats}`}>
          <div><span>RATING</span><b>{session.ratingCurrent?.toLocaleString("en-US") ?? EMPTY_VALUE}</b></div>
          <div><span>STREAM</span><b>{session.wins}–{session.losses}</b></div>
          <div><span>WIN RATE</span><b>{total ? `${winRate}%` : EMPTY_VALUE}</b></div>
        </div>
      </div>
    </Panel>
  );
}

function StreamProfile({ session, account, title = "STREAM PROFILE", goal }: { session: LocalSessionSummary; account: OverlayStateSnapshot["account"]; title?: string; goal?: QueueSettings["channelGoal"] }) {
  const delta = session.sessionDelta;
  const twitch = account?.twitch;
  const channelName = twitch?.displayName || twitch?.login || "TWITCH CHANNEL";
  const ratingGoal = goal?.type === "rating";
  // Legacy rating goals could carry the old default zero. Preserve their
  // useful session baseline until the user explicitly saves a new start.
  const goalStart = goal?.startValue && goal.startValue > 0
    ? goal.startValue
    : session.ratingStart ?? session.ratingCurrent ?? 0;
  const goalCurrent = session.ratingCurrent ?? goalStart;
  const goalTarget = goal?.targetValue ?? goalCurrent;
  const goalProgress = ratingGoal ? Math.max(0, Math.min(100, ((goalCurrent - goalStart) / Math.max(1, goalTarget - goalStart)) * 100)) : 100;
  return (
    <Panel title={title} className={styles.streamProfile}>
      <div className={`${styles.streamProfileBody} ${parity.streamProfileBody}`}>
        <span className={styles.twitchAvatarFrame}>{twitch?.profileImageUrl ? <img className={styles.avatarImage} src={twitch.profileImageUrl} alt="" /> : <span className={styles.twitchAvatar}>{channelName.slice(0, 2).toUpperCase()}</span>}</span>
        <div><strong>{channelName}</strong><small>{twitch?.live?.title || "МЕЖДУ МАТЧАМИ"}</small></div>
        <div className={`${styles.liveBadge} ${parity.liveBadge}`}><i data-online={Boolean(twitch?.live)} /> {twitch?.live ? `${twitch.live.viewerCount} LIVE` : "OFFLINE"}</div>
        <div className={styles.goal}>
          <span className={styles.goalTrack}>
            <i style={{ width: `${goalProgress}%` }} />
            <span className={`${styles.goalMeta} ${parity.goalMeta}`}>
              <span>{goal && goal.type !== "none" && goal.label ? goal.label : "SESSION MMR"}</span>
              <b>{ratingGoal ? `${goalStart} · ${goalCurrent} → ${goalTarget}` : goal?.type === "custom" ? `${goal.startValue} → ${goal.targetValue}` : `${session.ratingStart ?? EMPTY_VALUE} → ${session.ratingCurrent ?? EMPTY_VALUE} (${formatDelta(delta)})`}</b>
            </span>
          </span>
        </div>
      </div>
    </Panel>
  );
}

function FeaturedMatch({ match, title = "LAST MATCH" }: { match: LocalMatchSummary | undefined; title?: string }) {
  const hero = match ? getHeroById(match.heroId) : null;
  const delta = match ? ratingDelta(match) : null;
  const inventory = INVENTORY_SLOTS.map((slot) => itemAsset(match?.inventory[slot]));
  const renderItem = (item: ReturnType<typeof itemAsset>, slot: number) => (
    <span key={slot} className={`${styles.item} ${parity.item}`} data-empty={item ? undefined : "true"} title={item?.label}>
      {item && <img src={item.url} alt={item.label} />}
    </span>
  );
  return (
    <Panel title={title} className={`${styles.featuredMatch} ${parity.featuredMatch}`}>
      <div className={styles.heroArt} data-empty={hero ? undefined : "true"}>
        {hero ? (
          <PreloadedVideo className={styles.featuredHeroImage} src={hero.videoUrl} poster={hero.portraitUrl} />
        ) : (
          <div className={styles.emptyMatchHero}>
            <img src={logoUrl} alt="" />
            <span>Match history is empty</span>
            <small>Your latest completed match will appear here</small>
          </div>
        )}
        <span className={styles.heroMist} />
      </div>
      <div className={styles.heroDetails}>
        <div className={`${styles.heroNameRow} ${parity.heroNameRow}`}>
          <strong>{hero?.localizedName ?? "No completed matches"}</strong>
          <em data-result={match?.result ?? undefined}>{match ? resultLabel(match) : "NO DATA"}</em>
        </div>
        <span className={`${styles.matchMeta} ${parity.matchMeta}`}>{match ? `${match.rankedMode.toUpperCase()} • ${formatDate(match.finalizedAt)}` : "MATCH DATA // WAITING"}</span>
        <div className={`${styles.matchStats} ${parity.matchStats}`}>
          <div className={styles.statsPrimary}>
            <span className={`${styles.statValue} ${parity.statValue}`}>{match && match.kills !== null && match.deaths !== null && match.assists !== null ? `${match.kills} / ${match.deaths} / ${match.assists}` : EMPTY_VALUE}</span>
            <span className={`${styles.statValue} ${parity.statValue}`} data-tone={delta === null ? undefined : delta > 0 ? "positive" : delta < 0 ? "negative" : undefined}>{delta === null ? EMPTY_VALUE : `${formatDelta(delta)} MMR`}</span>
          </div>
          <span className={`${styles.statsSecondary} ${parity.statsSecondary}`}>KDA {match && match.kills !== null && match.deaths !== null && match.assists !== null ? ((match.kills + match.assists) / Math.max(1, match.deaths)).toFixed(2) : EMPTY_VALUE}</span>
        </div>
        <div className={styles.inventory} aria-label="Last recorded inventory">
          <div className={`${styles.items} ${parity.inventory}`}>{inventory.slice(0, 6).map(renderItem)}</div>
          <div className={`${styles.backpackItems} ${parity.backpackItems}`}>{inventory.slice(6).map((item, index) => renderItem(item, index + 6))}</div>
        </div>
      </div>
    </Panel>
  );
}

function WebcamPanel({ title, imageUrl }: { title: string; imageUrl: string | null }) {
  const resolvedUrl = imageUrl?.startsWith("/") ? `https://prereborn.ru${imageUrl}` : imageUrl;
  return <Panel title={title} className={styles.webcamPanel}><div className={`${styles.webcam} ${parity.webcam}`} data-has-image={Boolean(resolvedUrl)}>{resolvedUrl ? <img src={resolvedUrl} alt="" /> : <><span>LIVE CAPTURE</span><small>FALLBACK NOT SET</small></>}</div></Panel>;
}

function FavoriteHeroes({ matches, heroIds, title }: { matches: LocalMatchSummary[]; heroIds: number[]; title: string }) {
  const counts = new Map<number, number>();
  matches.forEach((match) => counts.set(match.heroId, (counts.get(match.heroId) ?? 0) + 1));
  const favorites = (heroIds.length ? heroIds.map((id) => [id, counts.get(id) ?? 0] as [number, number]) : [...counts].sort((a, b) => b[1] - a[1])).slice(0, 3);
  return (
    <Panel title={title} className={styles.favorites}>
      <div className={styles.favoriteList}>
        {favorites.length ? favorites.map(([heroId]) => {
          const hero = getHeroById(heroId);
          return (
            <div className={`${styles.favorite} ${parity.favorite}`} key={heroId}>
              <div className={styles.favoritePortrait}>
                {hero ? <PreloadedVideo className="" src={hero.videoUrl} poster={hero.portraitUrl} /> : <span>?</span>}
                {hero && <img className={styles.attributeIcon} src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_${hero.attribute}.png`} alt="" />}
              </div>
              <div className={styles.favoriteCaption}><b>{hero?.localizedName ?? `Hero ${heroId}`}</b></div>
            </div>
          );
        }) : <div className={`${styles.panelEmpty} ${parity.panelEmpty}`}>No match history yet</div>}
      </div>
    </Panel>
  );
}

function RecentGames({ matches, title, limit }: { matches: LocalMatchSummary[]; title: string; limit: number }) {
  return (
    <Panel title={title} className={styles.recentGames}>
      <div className={styles.gamesList}>
        {matches.length ? matches.slice(0, limit).map((match, index) => {
          const hero = getHeroById(match.heroId);
          const result = resultLabel(match);
          const delta = ratingDelta(match);
          return (
            <div className={`${styles.gameRow} ${parity.gameRow}`} key={match.matchId ?? `${match.startedAt}-${index}`} data-session="current">
              {hero ? <img className={styles.gameHeroImage} src={hero.portraitUrl} alt="" /> : <span className={`${styles.gameMark} ${parity.gameMark}`}>?</span>}
              <div><b>{hero?.localizedName.toUpperCase() ?? `HERO ${match.heroId}`}</b><small>{match.kills !== null && match.deaths !== null && match.assists !== null ? `${match.kills}/${match.deaths}/${match.assists}` : "FINALIZED"}</small></div>
              <em data-result={result}>{result}</em>
              <strong data-positive={delta !== null && delta > 0}>({formatDelta(delta)})</strong>
              <time>{formatDate(match.finalizedAt)}</time>
            </div>
          );
        }) : <div className={`${styles.panelEmpty} ${parity.panelEmpty}`}>No completed matches</div>}
      </div>
    </Panel>
  );
}

function CommunityArea({ account, settings, title }: { account: OverlayStateSnapshot["account"]; settings: QueueSettings["widgets"]["friends"]; title: string }) {
  const donors = account?.donationAlerts?.topDonors?.slice(0, 3) ?? [];
  const followers = account?.twitch?.recentFollowers ?? [];
  const subscribers = account?.twitch?.recentSubscribers ?? [];
  const avatar = (id: string) => getHeroById((Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 125) + 1)?.portraitUrl;
  const donationRank = (amount: number) => {
    const rank = donationRanks.find((candidate) => amount >= candidate.min)!;
    const medalFile = rank.tier === 8 ? "immortal.png" : `${rank.name.toLowerCase()}-${rank.stars}.png`;
    return { src: communityMedals[`../assets/rank-medals/${medalFile}`], label: rank.stars ? `${rank.name} ${"★".repeat(rank.stars)}` : rank.name };
  };
  return (
      <Panel title={title} className={styles.donationPanel}>
        <div className={styles.friendsBody}>
          {settings.showDonaters && donors.length > 0 && <section className={styles.friendSection}><h3>Donaters</h3><div className={styles.friendGrid}>{donors.map((donor) => { const rank = donationRank(donor.amount); return <div className={styles.friendEntry} key={`${donor.username}-${donor.currency}`}><img src={rank.src} alt={`${rank.label} medal`} width={42} height={42} /><p><strong>{donor.username}</strong><small>{new Intl.NumberFormat("ru-RU").format(donor.amount)} {donor.currency}</small></p></div>; })}</div></section>}
          {settings.showSubscribers && subscribers.length > 0 && <section className={styles.friendSection}><h3>Subscribers</h3><div className={styles.friendGrid}>{subscribers.map((person) => <div className={styles.friendEntry} key={person.id}><span className={styles.friendAvatarFrame}>{avatar(person.id) && <img className={styles.friendAvatar} src={avatar(person.id)} alt="" />}</span><p><strong>{person.name}</strong><small>Tier {person.tier.slice(0, 1)} subscriber</small></p></div>)}</div></section>}
          {settings.showFollowers && followers.length > 0 && <section className={styles.friendSection}><h3>Recent followers</h3><div className={styles.friendGrid}>{followers.map((person) => <div className={styles.friendEntry} key={person.id}><span className={styles.friendAvatarFrame}>{avatar(person.id) && <img className={styles.friendAvatar} src={avatar(person.id)} alt="" />}</span><p><strong>{person.name}</strong><small>Followed the channel</small></p></div>)}</div></section>}
          {settings.socialLinks.length > 0 && <section className={styles.friendSection}><h3>Socials</h3><div className={styles.friendGrid}>{settings.socialLinks.map((link) => <div className={styles.friendEntry} key={link.id}><i>{link.platform.slice(0, 2).toUpperCase()}</i><p><strong>{link.label}</strong><small>{link.url}</small></p></div>)}</div></section>}
        </div>
      </Panel>
  );
}

function TwitchChat({ chat, title, limit }: { chat: OverlayStateSnapshot["twitchChat"]; title: string; limit: number }) {
  const messages = chat?.messages.slice(-Math.max(1, limit)) ?? [];
  return (
    <Panel title={title} className={styles.chatPanel}>
      <div className={styles.chatBody} aria-live="polite">
        <div className={styles.chatStatus} data-connected={Boolean(chat?.connected)}>
          <i />{chat?.connected ? "LIVE CHAT" : chat?.state === "reconnecting" ? "RECONNECTING" : "CONNECTING"}
        </div>
        <div className={styles.chatMessages}>
          {messages.length ? messages.map((message) => (
            <p key={message.id}>
              <span style={message.color ? { color: message.color } : undefined}>{message.author}</span>
              <b>:</b> {message.text}
            </p>
          )) : <div className={styles.chatWaiting}>Messages will appear here when chat becomes active</div>}
        </div>
      </div>
    </Panel>
  );
}

export function BetweenMatchesScene({ session, settings = null, account = null, twitchChat = null }: { session: LocalSessionSummary; settings?: QueueSettings | null; account?: OverlayStateSnapshot["account"]; twitchChat?: OverlayStateSnapshot["twitchChat"] }) {
  const sceneStyle = {
    width: "100%",
    height: "100%",
    "--queue-logo-url": `url(${logoUrl})`,
  } as React.CSSProperties;
  return (
    <main className={styles.scene} data-testid="between-matches-production" data-coordinate-system="viewport" style={sceneStyle}>
      <Atmosphere />
      <div className={styles.interface}>
        <div className={styles.dashboard} data-top-count={2}>
          <PlayerProfile session={session} account={account} />
          <StreamProfile session={session} account={account} goal={settings?.channelGoal} />
          <div className={styles.leftMain} data-featured="true">
            <FeaturedMatch match={session.recentMatches[0]} />
            <div className={styles.sideStack} data-widget-count={3}>
              <WebcamPanel title="LIVE CAPTURE" imageUrl={settings?.webcamImageUrl ?? null} />
              <FavoriteHeroes title="FAVORITE HEROES" matches={session.recentMatches} heroIds={settings?.favoriteHeroIds ?? []} />
              <RecentGames title="RECENT GAMES" matches={session.recentMatches} limit={settings?.widgets.recentGamesLimit ?? 5} />
            </div>
          </div>
          <div className={styles.rightMain}>
            <TwitchChat chat={twitchChat} title="TWITCH CHAT" limit={settings?.widgets.chatMessagesLimit ?? 12} />
            {settings && <CommunityArea title="COMMUNITY" account={account} settings={settings.widgets.friends} />}
          </div>
        </div>
      </div>
    </main>
  );
}
