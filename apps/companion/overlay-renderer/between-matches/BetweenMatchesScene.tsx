import { useState } from "react";
import { getHeroById } from "../../src/services/heroCatalog";
import { RedFogBackground } from "../../../web/src/components/pages/stream/queue/red-fog-background";
import treeFarUrl from "../../../web/public/generated/chatgpt/trees-1.png";
import treeMiddleUrl from "../../../web/public/generated/chatgpt/trees-2.png";
import treeNearUrl from "../../../web/public/generated/chatgpt/trees-3.png";
import logoUrl from "../../../web/public/logo-new.png";
import type { LocalMatchSummary, LocalSessionSummary, QueueSettings } from "../types";
import styles from "../../../web/src/components/pages/stream/queue/queue-scene.module.scss";

const EMPTY_VALUE = "—";
const INVENTORY_SLOTS = Array.from({ length: 9 }, (_, index) => index);

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
      <div className={styles.panelTitle}><span>{title}</span></div>
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

function Atmosphere() {
  const treeStyle = { position: "absolute", inset: 0, width: "100%", height: "100%" } as const;
  return (
    <>
      <div className={styles.fallback} aria-hidden="true" />
      <div className={styles.treeStage} aria-hidden="true">
        <div className={`${styles.treeLayer} ${styles.treeDistantSilhouette}`}><img className={styles.treeImage} style={treeStyle} src={treeMiddleUrl} alt="" /></div>
        <div className={`${styles.treeLayer} ${styles.treeFar}`}><img className={styles.treeImage} style={treeStyle} src={treeFarUrl} alt="" /></div>
        <div className={`${styles.treeLayer} ${styles.treeMiddle}`}><img className={styles.treeImage} style={treeStyle} src={treeMiddleUrl} alt="" /></div>
        <div className={`${styles.treeLayer} ${styles.treeNear}`}><img className={styles.treeImage} style={treeStyle} src={treeNearUrl} alt="" /></div>
        <div className={styles.treeFogMiddle} />
        <div className={styles.treeFogFront} />
      </div>
      {import.meta.env.MODE !== "test" && typeof window.matchMedia === "function" && (
        <RedFogBackground quality="high" seed={123} forceFallback={false} onDebugStateChange={() => undefined} />
      )}
      <div className={styles.atmosphereFinish} aria-hidden="true" />
    </>
  );
}

function PlayerProfile({ session, title = "PLAYER PROFILE" }: { session: LocalSessionSummary; title?: string }) {
  const total = session.wins + session.losses;
  const winRate = total ? Math.round((session.wins / total) * 100) : 0;
  return (
    <Panel title={title} className={styles.playerProfile}>
      <div className={styles.profileBody}>
        <div className={styles.profileBrand}>
          <span><strong>PREREBORN</strong><small>Companion</small></span>
          <img src={logoUrl} alt="" />
        </div>
        <div className={styles.profileAvatarFrame}><div className={styles.avatar}>PR</div></div>
        <div className={styles.playerIdentity}><strong>LOCAL SESSION</strong></div>
        <div className={styles.profileStats}>
          <div><span>RATING</span><b>{session.ratingCurrent?.toLocaleString("en-US") ?? EMPTY_VALUE}</b></div>
          <div><span>STREAM</span><b>{session.wins}–{session.losses}</b></div>
          <div><span>WIN RATE</span><b>{total ? `${winRate}%` : EMPTY_VALUE}</b></div>
        </div>
      </div>
    </Panel>
  );
}

function StreamProfile({ session, title = "STREAM PROFILE", goal }: { session: LocalSessionSummary; title?: string; goal?: QueueSettings["channelGoal"] }) {
  const delta = session.sessionDelta;
  return (
    <Panel title={title} className={styles.streamProfile}>
      <div className={styles.streamProfileBody}>
        <span className={styles.twitchAvatarFrame}><span className={styles.twitchAvatar}>PR</span></span>
        <div><strong>МЕЖДУ МАТЧАМИ</strong><small>LOCAL COMPANION OVERLAY</small></div>
        <div className={styles.liveBadge}><i data-online="true" /> SESSION LIVE</div>
        <div className={styles.goal}>
          <span className={styles.goalTrack}>
            <i style={{ width: "100%" }} />
            <span className={styles.goalMeta}>
              <span>{goal && goal.type !== "none" && goal.label ? goal.label : "SESSION MMR"}</span>
              <b>{goal && goal.type !== "none" ? `${goal.startValue} → ${goal.targetValue}` : `${session.ratingStart ?? EMPTY_VALUE} → ${session.ratingCurrent ?? EMPTY_VALUE} (${formatDelta(delta)})`}</b>
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
  return (
    <Panel title={title} className={styles.featuredMatch}>
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
        <div className={styles.heroNameRow}>
          <strong>{hero?.localizedName ?? "No completed matches"}</strong>
          <em data-result={match?.result ?? undefined}>{match ? resultLabel(match) : "NO DATA"}</em>
        </div>
        <span className={styles.matchMeta}>{match ? `${match.rankedMode.toUpperCase()} • ${formatDate(match.finalizedAt)}` : "MATCH DATA // WAITING"}</span>
        <div className={styles.matchStats}>
          <div className={styles.statsPrimary}>
            <span className={styles.statValue}>KDA {EMPTY_VALUE}</span>
            <span className={styles.statValue} data-tone={delta === null ? undefined : delta > 0 ? "positive" : delta < 0 ? "negative" : undefined}>{delta === null ? EMPTY_VALUE : `${formatDelta(delta)} MMR`}</span>
          </div>
          <span className={styles.statsSecondary}>FINALIZED LOCAL MATCH</span>
        </div>
        <div className={styles.inventory} aria-label="Last recorded inventory">
          <div className={styles.items}>{INVENTORY_SLOTS.slice(0, 6).map((slot) => <span key={slot} className={styles.item} data-empty="true" />)}</div>
          <div className={styles.backpackItems}>{INVENTORY_SLOTS.slice(6).map((slot) => <span key={slot} className={styles.item} data-empty="true" />)}</div>
        </div>
      </div>
    </Panel>
  );
}

function WebcamPanel({ title, imageUrl }: { title: string; imageUrl: string }) {
  return <Panel title={title} className={styles.webcamPanel}><div className={styles.webcam}><img src={imageUrl} alt="" /></div></Panel>;
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
            <div className={styles.favorite} key={heroId}>
              <div className={styles.favoritePortrait}>
                {hero ? <PreloadedVideo className="" src={hero.videoUrl} poster={hero.portraitUrl} /> : <span>?</span>}
                {hero && <img className={styles.attributeIcon} src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_${hero.attribute}.png`} alt="" />}
              </div>
              <div className={styles.favoriteCaption}><b>{hero?.localizedName ?? `Hero ${heroId}`}</b></div>
            </div>
          );
        }) : <div className={styles.panelEmpty}>No match history yet</div>}
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
            <div className={styles.gameRow} key={match.matchId ?? `${match.startedAt}-${index}`} data-session="current">
              {hero ? <img className={styles.gameHeroImage} src={hero.portraitUrl} alt="" /> : <span className={styles.gameMark}>?</span>}
              <div><b>{hero?.localizedName.toUpperCase() ?? `HERO ${match.heroId}`}</b><small>FINALIZED</small></div>
              <em data-result={result}>{result}</em>
              <strong data-positive={delta !== null && delta > 0}>({formatDelta(delta)})</strong>
              <time>{formatDate(match.finalizedAt)}</time>
            </div>
          );
        }) : <div className={styles.panelEmpty}>No completed matches</div>}
      </div>
    </Panel>
  );
}

function CommunityArea({ links, title }: { links: QueueSettings["widgets"]["friends"]["socialLinks"]; title: string }) {
  return (
      <Panel title={title} className={styles.donationPanel}>
        <div className={styles.friendsBody}>
          <section className={styles.friendSection}><div className={styles.friendGrid}>{links.map((link) => <div className={styles.friendEntry} key={link.id}><i>{link.platform.slice(0, 2).toUpperCase()}</i><p><strong>{link.label}</strong><small>{link.url}</small></p></div>)}</div></section>
        </div>
      </Panel>
  );
}

export function BetweenMatchesScene({ session, settings = null }: { session: LocalSessionSummary; settings?: QueueSettings | null }) {
  const visible = settings?.visibility;
  const titles = settings?.widgets.titles;
  const sceneStyle = {
    width: "100%",
    height: "100%",
    "--queue-logo-url": `url(${logoUrl})`,
  } as React.CSSProperties;
  return (
    <main className={styles.scene} data-testid="between-matches-production" style={sceneStyle}>
      <Atmosphere />
      <div className={styles.interface}>
        <div className={styles.dashboard} data-top-count={2}>
          {visible?.playerProfile !== false && <PlayerProfile session={session} title={titles?.playerProfile} />}
          {visible?.streamProfile !== false && <StreamProfile session={session} title={titles?.streamProfile} goal={settings?.channelGoal} />}
          <div className={styles.leftMain} data-featured="true">
            {visible?.featuredMatch !== false && <FeaturedMatch match={session.recentMatches[0]} title={titles?.featuredMatch} />}
            <div className={styles.sideStack} data-widget-count={3}>
              {visible?.webcam !== false && settings?.webcamImageUrl && <WebcamPanel title={titles?.webcam ?? "LIVE CAPTURE"} imageUrl={settings.webcamImageUrl} />}
              {visible?.favoriteHeroes !== false && <FavoriteHeroes title={titles?.favoriteHeroes ?? "FAVORITE HEROES"} matches={session.recentMatches} heroIds={settings?.favoriteHeroIds ?? []} />}
              {visible?.recentGames !== false && <RecentGames title={titles?.recentGames ?? "RECENT GAMES"} matches={session.recentMatches} limit={settings?.widgets.recentGamesLimit ?? 5} />}
            </div>
          </div>
          {(settings?.widgets.friends.socialLinks.length ?? 0) > 0 && <div className={styles.rightMain}><CommunityArea title={titles?.friends ?? "COMMUNITY"} links={settings?.widgets.friends.socialLinks ?? []} /></div>}
        </div>
      </div>
    </main>
  );
}
