import { useState } from "react";
import { getHeroById } from "../../src/services/heroCatalog";
import { RedFogBackground } from "../../../web/src/components/pages/stream/queue/red-fog-background";
import treeFarUrl from "../../../web/public/generated/chatgpt/trees-1.png";
import treeMiddleUrl from "../../../web/public/generated/chatgpt/trees-2.png";
import treeNearUrl from "../../../web/public/generated/chatgpt/trees-3.png";
import logoUrl from "../../../web/public/logo-new.png";
import type { LocalMatchSummary, LocalSessionSummary } from "../types";
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

function PlayerProfile({ session }: { session: LocalSessionSummary }) {
  const total = session.wins + session.losses;
  const winRate = total ? Math.round((session.wins / total) * 100) : 0;
  return (
    <Panel title="PLAYER PROFILE" className={styles.playerProfile}>
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

function StreamProfile({ session }: { session: LocalSessionSummary }) {
  const delta = session.sessionDelta;
  return (
    <Panel title="STREAM PROFILE" className={styles.streamProfile}>
      <div className={styles.streamProfileBody}>
        <span className={styles.twitchAvatarFrame}><span className={styles.twitchAvatar}>PR</span></span>
        <div><strong>МЕЖДУ МАТЧАМИ</strong><small>LOCAL COMPANION OVERLAY</small></div>
        <div className={styles.liveBadge}><i data-online="true" /> SESSION LIVE</div>
        <div className={styles.goal}>
          <span className={styles.goalTrack}>
            <i style={{ width: "100%" }} />
            <span className={styles.goalMeta}>
              <span>SESSION MMR</span>
              <b>{session.ratingStart ?? EMPTY_VALUE} → {session.ratingCurrent ?? EMPTY_VALUE} ({formatDelta(delta)})</b>
            </span>
          </span>
        </div>
      </div>
    </Panel>
  );
}

function FeaturedMatch({ match }: { match: LocalMatchSummary | undefined }) {
  const hero = match ? getHeroById(match.heroId) : null;
  const delta = match ? ratingDelta(match) : null;
  return (
    <Panel title="LAST MATCH" className={styles.featuredMatch}>
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

function WebcamPanel() {
  return <Panel title="LIVE CAPTURE" className={styles.webcamPanel}><div className={styles.webcam}><span>LIVE CAPTURE</span><small>EXTERNAL OBS SOURCE</small></div></Panel>;
}

function FavoriteHeroes({ matches }: { matches: LocalMatchSummary[] }) {
  const counts = new Map<number, number>();
  matches.forEach((match) => counts.set(match.heroId, (counts.get(match.heroId) ?? 0) + 1));
  const favorites = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <Panel title="FAVORITE HEROES" className={styles.favorites}>
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

function RecentGames({ matches }: { matches: LocalMatchSummary[] }) {
  return (
    <Panel title="RECENT GAMES" className={styles.recentGames}>
      <div className={styles.gamesList}>
        {matches.length ? matches.slice(0, 5).map((match, index) => {
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

function TwitchArea() {
  return (
    <>
      <Panel title="TWITCH CHAT" className={styles.chatPanel}>
        <div className={`${styles.chatBody} ${styles.chatUnavailable}`}>
          <i aria-hidden="true">T</i><strong>TWITCH PANEL</strong>
          <span>Local mode keeps the production composition without remote runtime dependency.</span>
        </div>
      </Panel>
      <Panel title="COMMUNITY" className={styles.donationPanel}>
        <div className={styles.friendsBody}>
          <section className={styles.friendSection}><h3>Local Companion</h3><div className={styles.friendGrid}><em>Stream community data is not required for this overlay.</em></div></section>
          <section className={styles.friendSection}><h3>Connection</h3><div className={styles.friendGrid}><div className={styles.friendEntry}><i>GSI</i><p><strong>LOCAL STATE</strong><small>AUTHORITATIVE SESSION DATA</small></p></div></div></section>
        </div>
      </Panel>
    </>
  );
}

export function BetweenMatchesScene({ session }: { session: LocalSessionSummary }) {
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
          <PlayerProfile session={session} />
          <StreamProfile session={session} />
          <div className={styles.leftMain} data-featured="true">
            <FeaturedMatch match={session.recentMatches[0]} />
            <div className={styles.sideStack} data-widget-count={3}>
              <WebcamPanel />
              <FavoriteHeroes matches={session.recentMatches} />
              <RecentGames matches={session.recentMatches} />
            </div>
          </div>
          <div className={styles.rightMain}><TwitchArea /></div>
        </div>
      </div>
    </main>
  );
}
