import Image from "next/image";
import { queueSceneMock as data } from "./queue-scene-mock";
import styles from "./queue-scene.module.scss";

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
        <div className={styles.panelTitle}><span>{title}</span></div>
        {children}
    </section>
);

const PlayerProfile = () => (
    <Panel title="Player record" className={styles.playerProfile}>
        <div className={styles.profileBody}>
            <div className={styles.avatar}>NW</div>
            <div className={styles.playerIdentity}>
                <span className={styles.overline}>ANCIENT RECORD // 04</span>
                <strong>{data.player.name}</strong>
                <span>{data.player.rank} Division · Europe</span>
            </div>
            <div className={styles.profileStats}>
                <div><span>RATING</span><b>{data.player.rating}</b></div>
                <div><span>STREAM</span><b>{data.player.wins}–{data.player.losses}</b></div>
                <div><span>WIN RATE</span><b>72%</b></div>
            </div>
        </div>
    </Panel>
);

const FeaturedMatch = () => (
    <Panel title="Last match // Featured hero" className={styles.featuredMatch}>
        <div className={styles.heroArt} aria-label="Neutral featured hero artwork">
            <span className={styles.heroSigil}>W</span>
            <span className={styles.heroWeapon} />
            <span className={styles.heroSilhouette} />
            <span className={styles.heroMist} />
        </div>
        <div className={styles.heroDetails}>
            <span className={styles.overline}>RANKED // MATCH 84361720</span>
            <div className={styles.heroNameRow}>
                <strong>{data.featuredMatch.hero}</strong>
                <em>{data.featuredMatch.result}</em>
            </div>
            <div className={styles.matchStats}>
                <div><span>K / D / A</span><b>{data.featuredMatch.kda}</b></div>
                <div><span>DURATION</span><b>{data.featuredMatch.duration}</b></div>
                <div><span>RATING</span><b className={styles.positive}>{data.featuredMatch.ratingChange}</b></div>
            </div>
            <div className={styles.items} aria-label="Last match items">
                {data.featuredMatch.items.map((item, index) => (
                    <span key={item} className={styles.item} data-tone={index % 3}>{item}</span>
                ))}
            </div>
        </div>
    </Panel>
);

const WebcamSlot = () => (
    <Panel title="Live capture" className={styles.webcamPanel}>
        <div className={styles.webcam} data-testid="webcam-slot">
            <span>WEBCAM</span><small>EXTERNAL SOURCE</small>
        </div>
    </Panel>
);

const FavoriteHeroes = () => (
    <Panel title="Favorite heroes" className={styles.favorites}>
        <div className={styles.favoriteList}>
            {data.favorites.map((hero, index) => (
                <div key={hero.name} className={styles.favorite}>
                    <span className={styles.miniPortrait}>{["W", "O", "S"][index]}</span>
                    <div><b>{hero.name}</b><small>{hero.games} matches</small></div>
                    <em>0{index + 1}</em>
                </div>
            ))}
        </div>
    </Panel>
);

const RecentGames = () => (
    <Panel title="Recent games" className={styles.recentGames}>
        <div className={styles.gamesList}>
            {data.recentGames.map((game, index) => (
                <div key={`${game.hero}-${index}`} className={styles.gameRow}>
                    <span className={styles.gameMark}>{game.hero[0]}</span>
                    <div><b>{game.hero}</b><small>{game.kda}</small></div>
                    <em data-result={game.result}>{game.result}</em>
                    <strong>{game.delta}</strong>
                </div>
            ))}
        </div>
    </Panel>
);

const StreamProfile = () => (
    <Panel title="Channel transmission" className={styles.streamProfile}>
        <div className={styles.streamProfileBody}>
            <span className={styles.twitchAvatar}>NW</span>
            <div><span className={styles.overline}>LIVE CHANNEL</span><strong>northwind_dota</strong><small>1,284 watching</small></div>
            <div className={styles.liveBadge}><i /> LIVE</div>
            <div className={styles.goal}>
                <div><span>ROAD TO 9,000</span><b>8,742 / 9,000</b></div>
                <span className={styles.goalTrack}><i /></span>
            </div>
        </div>
    </Panel>
);

const TwitchChat = () => (
    <Panel title="Twitch chat" className={styles.chatPanel}>
        <div className={styles.chatBody}>
            {data.chat.map(([user, message], index) => (
                <p key={user}><span data-color={index % 4}>{user}</span><b>:</b> {message}</p>
            ))}
        </div>
        <div className={styles.chatFooter}>CHANNEL CHAT // READ ONLY</div>
    </Panel>
);

const Supporters = () => (
    <Panel title="Community // Supporters" className={styles.supporters}>
        <div className={styles.supporterGrid}>
            {data.supporters.map((name, index) => (
                <div key={name}><span>{name[0]}</span><p><b>{name}</b><small>{index < 2 ? "FOUNDER" : "SUPPORTER"}</small></p></div>
            ))}
        </div>
    </Panel>
);

export const QueueSceneUi = () => (
    <div className={styles.interface}>
        <header className={styles.topBar}>
            <Image
                className={styles.brandLogo}
                src="/logo.png"
                width={52}
                height={52}
                alt="PreReborn Companion"
                priority
            />
            <div className={styles.brand}><strong>PREREBORN</strong><span>COMPANION</span></div>
            <div className={styles.navOrnaments}><span>PROFILE</span><span>HEROES</span><span>HISTORY</span><span>COMMUNITY</span></div>
            <div className={styles.broadcast}><i /> LIVE BROADCAST</div>
        </header>
        <div className={styles.dashboard}>
            <PlayerProfile />
            <StreamProfile />
            <div className={styles.leftMain}>
                <FeaturedMatch />
                <div className={styles.sideStack}>
                    <WebcamSlot />
                    <FavoriteHeroes />
                    <RecentGames />
                </div>
            </div>
            <div className={styles.rightMain}>
                <TwitchChat />
                <Supporters />
            </div>
        </div>
        <footer className={styles.sceneFooter}><span>EUROPE WEST // ARCHIVE ONLINE</span><span>PREREBORN COMPANION // OBS SCENE</span></footer>
    </div>
);
