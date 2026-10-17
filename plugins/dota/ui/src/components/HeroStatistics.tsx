// Preserved real local/OpenDota presentation from the former Hero Detail.
import {useEffect,useState} from "react";
import {Button} from "./ui";
import {getHeroLocalStats,getHeroOpenDotaStats,getHeroOpenDotaInsights,getFavoriteHeroes,saveFavoriteHeroes,type HeroLocalStats,type HeroOpenDotaStats,type HeroOpenDotaInsights,type LocalMatchResultValue} from "../services/dotaCompanionApi";
const RESULT_LABEL:Record<LocalMatchResultValue,string>={win:"Победа",loss:"Поражение",abandon:"Оставлен"};
function formatAvg(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

// WK-140 - RIGHT zone: honest local statistics, not a dashboard. Typography
// + a compact recent-results row, no KPI tiles/charts/bordered panel - see
// this task's own "no boxed dashboard" requirement. Explicitly captioned as
// Companion's own local history (not lifetime Dota stats, and not yet
// enriched by OpenDota - see this component's data-boundary doc comment
// below) so the numbers are never mistaken for something they aren't.
function HeroStatsPanel({ stats }: { stats: HeroLocalStats | null }) {
  if (!stats) return null;

  if (stats.matches === 0) {
    return (
      <div className="hero-detail__stats">
        <h3 className="hero-detail__stats-title">Статистика</h3>
        <p className="hero-detail__stats-empty">Пока нет матчей в локальной истории</p>
      </div>
    );
  }

  const decided = stats.wins + stats.losses;
  const winrate = decided > 0 ? (stats.wins / decided) * 100 : null;
  const hasKda = stats.avgKills !== null || stats.avgDeaths !== null || stats.avgAssists !== null;

  return (
    <div className="hero-detail__stats">
      <h3 className="hero-detail__stats-title">Статистика</h3>
      <dl className="hero-detail__stats-list">
        <div className="hero-detail__stats-row"><dt>Матчи</dt><dd>{stats.matches}</dd></div>
        <div className="hero-detail__stats-row"><dt>Победы</dt><dd>{stats.wins}</dd></div>
        <div className="hero-detail__stats-row"><dt>Поражения</dt><dd>{stats.losses}</dd></div>
        <div className="hero-detail__stats-row"><dt>Винрейт</dt><dd>{winrate === null ? "—" : `${winrate.toFixed(1)}%`}</dd></div>
        {hasKda && (
          <div className="hero-detail__stats-row">
            <dt>Ср. K/D/A</dt>
            <dd>{formatAvg(stats.avgKills)} / {formatAvg(stats.avgDeaths)} / {formatAvg(stats.avgAssists)}</dd>
          </div>
        )}
      </dl>
      {stats.recentResults.length > 0 && (
        <div className="hero-detail__stats-recent" aria-label="Последние результаты на этом герое">
          {stats.recentResults.map((result, index) => (
            <span
              key={index}
              className={`hero-detail__stats-dot hero-detail__stats-dot--${result}`}
              title={RESULT_LABEL[result]}
            />
          ))}
        </div>
      )}
      <p className="hero-detail__stats-caption">Локальная история Companion</p>
    </div>
  );
}

// WK-133 - RIGHT zone addendum: OpenDota's external per-hero statistics,
// clearly separated from HeroStatsPanel's local history (see this task's
// "never merge local + external" requirement) - a distinct component below
// HeroStatsPanel rather than a merged row/total, same DTO-only boundary
// HeroStatsPanel itself already established. Enrichment only: every branch
// here renders something small and restrained, never a full-page error -
// HeroStatsPanel above it always renders normally regardless of this
// component's state.
// WK-148 - "ПОСЛЕДНИЕ N"/"ПАТЧ 7.XX"/KDA-GPM-XPM/ranking, additive to the
// lifetime block above (задача, секции 2-3). Every sub-block is independently
// omitted when its data is null/insufficient - never a placeholder, never a
// misleading "0 матчей" (see computeHeroPatchStats/computeHeroParsedAverages
// in apps/api for why each field can legitimately be null).
function HeroOpenDotaInsightsBlock({ insights }: { insights: HeroOpenDotaInsights | null }) {
  if (!insights || insights.status !== "ok") return null;

  const kdaAvailable = insights.kills !== null && insights.deaths !== null && insights.assists !== null;
  const hasParsedMetrics = insights.heroDamage !== null || insights.towerDamage !== null || insights.heroHealing !== null;

  return (
    <>
      {insights.recentForm && (
        <div className="hero-detail__stats-group">
          <p className="hero-detail__stats-subhead">Последние {insights.recentForm.sample}</p>
          <p className="hero-detail__stats-line">
            {insights.recentForm.wins}–{insights.recentForm.losses} · {insights.recentForm.winRate.toFixed(1)}%
          </p>
        </div>
      )}

      {insights.patch && insights.patch.patchName && (
        <div className="hero-detail__stats-group">
          {/* WK-148 polish - isLatestKnown distinguishes "this hero's current
              observed patch is confirmed to be OpenDota's latest known patch"
              from "this is merely the newest patch this player has played" -
              only the former may say "Патч", the latter must say "Последний
              патч" so it never falsely implies the live game patch. */}
          <p className="hero-detail__stats-subhead">
            {insights.patch.isLatestKnown ? "Патч" : "Последний патч ·"} {insights.patch.patchName}
          </p>
          <p className="hero-detail__stats-line">
            {insights.patch.wins}–{insights.patch.losses} · {insights.patch.winRate.toFixed(1)}%
          </p>
        </div>
      )}

      {(kdaAvailable || insights.goldPerMin !== null || insights.xpPerMin !== null || hasParsedMetrics) && (
        <dl className="hero-detail__stats-list hero-detail__stats-list--compact">
          {kdaAvailable && (
            <div className="hero-detail__stats-row">
              <dt>KDA</dt>
              <dd>{insights.kills!.toFixed(1)} / {insights.deaths!.toFixed(1)} / {insights.assists!.toFixed(1)}</dd>
            </div>
          )}
          {insights.goldPerMin !== null && (
            <div className="hero-detail__stats-row"><dt>GPM</dt><dd>{Math.round(insights.goldPerMin)}</dd></div>
          )}
          {insights.xpPerMin !== null && (
            <div className="hero-detail__stats-row"><dt>XPM</dt><dd>{Math.round(insights.xpPerMin)}</dd></div>
          )}
          {insights.heroDamage !== null && (
            <div className="hero-detail__stats-row"><dt>Урон герою</dt><dd>{Math.round(insights.heroDamage)}</dd></div>
          )}
          {insights.towerDamage !== null && (
            <div className="hero-detail__stats-row"><dt>Урон башням</dt><dd>{Math.round(insights.towerDamage)}</dd></div>
          )}
          {insights.heroHealing !== null && (
            <div className="hero-detail__stats-row"><dt>Лечение</dt><dd>{Math.round(insights.heroHealing)}</dd></div>
          )}
        </dl>
      )}

      {insights.rankPercent !== null && (
        <p className="hero-detail__stats-caption">Рейтинг героя: топ {(100 - insights.rankPercent).toFixed(1)}%</p>
      )}
    </>
  );
}

function HeroOpenDotaPanel({ stats, insights, onOpenIntegrations }: { stats: HeroOpenDotaStats | null; insights: HeroOpenDotaInsights | null; onOpenIntegrations: () => void }) {
  if (!stats) {
    return (
      <div className="hero-detail__stats hero-detail__stats--opendota">
        <h3 className="hero-detail__stats-title">OpenDota</h3>
        <p className="matches-panel__empty">Загрузка…</p>
      </div>
    );
  }

  if (stats.status === "steam_not_connected") {
    return (
      <div className="hero-detail__stats hero-detail__stats--opendota">
        <h3 className="hero-detail__stats-title">OpenDota</h3>
        <p className="hero-detail__stats-empty">Steam не привязан</p>
        <Button variant="ghost" onClick={onOpenIntegrations}>Как привязать Steam</Button>
      </div>
    );
  }

  if (stats.status === "no_data") {
    return (
      <div className="hero-detail__stats hero-detail__stats--opendota">
        <h3 className="hero-detail__stats-title">OpenDota</h3>
        <p className="hero-detail__stats-empty">Нет данных OpenDota по этому герою.</p>
      </div>
    );
  }

  if (stats.status === "rate_limited" || stats.status === "unavailable") {
    return (
      <div className="hero-detail__stats hero-detail__stats--opendota">
        <h3 className="hero-detail__stats-title">OpenDota</h3>
        <p className="hero-detail__stats-empty">
          {stats.status === "rate_limited" ? "OpenDota временно ограничивает запросы." : "OpenDota сейчас недоступна."}
        </p>
      </div>
    );
  }

  return (
    <div className="hero-detail__stats hero-detail__stats--opendota">
      <h3 className="hero-detail__stats-title">OpenDota</h3>
      <dl className="hero-detail__stats-list">
        <div className="hero-detail__stats-row"><dt>Матчи</dt><dd>{stats.games}</dd></div>
        <div className="hero-detail__stats-row"><dt>Победы</dt><dd>{stats.wins}</dd></div>
        <div className="hero-detail__stats-row"><dt>Поражения</dt><dd>{stats.losses}</dd></div>
        <div className="hero-detail__stats-row">
          <dt>Винрейт</dt>
          <dd>{stats.winRate === null ? "—" : `${stats.winRate.toFixed(1)}%`}</dd>
        </div>
      </dl>
      <HeroOpenDotaInsightsBlock insights={insights} />
    </div>
  );
}


export function HeroStatistics({heroId}:{heroId:number}){
 const [local,setLocal]=useState<HeroLocalStats|null>(null);const [stats,setStats]=useState<HeroOpenDotaStats|null>(null);const [insights,setInsights]=useState<HeroOpenDotaInsights|null>(null);
 const [favorites,setFavorites]=useState<number[]|null>(null);const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);const [info,setInfo]=useState(false);
 useEffect(()=>{let stopped=false;setLocal(null);setStats(null);setInsights(null);setFavorites(null);setError(null);
  const load=()=>{
  void getHeroLocalStats(heroId).then(value=>{if(!stopped)setLocal(value);}).catch(e=>{if(!stopped)setError(String(e));});
  void getFavoriteHeroes().then(value=>{if(!stopped)setFavorites(value);}).catch(e=>{if(!stopped)setError(String(e));});
  void getHeroOpenDotaStats(heroId).then(value=>{if(!stopped)setStats(value);}).catch(()=>{if(!stopped)setStats({status:"unavailable"});});
  void getHeroOpenDotaInsights(heroId).then(value=>{if(!stopped)setInsights(value);}).catch(()=>{if(!stopped)setInsights({status:"unavailable"});});
  };load();window.addEventListener("focus",load);return()=>{stopped=true;window.removeEventListener("focus",load);};
 },[heroId]);
 const toggle=async()=>{if(!favorites||busy)return;const next=favorites.includes(heroId)?favorites.filter(id=>id!==heroId):[...favorites,heroId];
  if(next.length>3){setError("Можно выбрать не больше 3 героев.");return;}setBusy(true);setError(null);
  try{setFavorites(await saveFavoriteHeroes(next));}catch(e){setError(String(e));}finally{setBusy(false);}
 };
 return <section className="hero-statistics">{error&&<p role="alert">{error}</p>}
  <button disabled={busy||favorites===null} onClick={()=>void toggle()}>{favorites?.includes(heroId)?"Убрать из избранного":"Добавить в избранное"}</button>
  <HeroStatsPanel stats={local}/><HeroOpenDotaPanel stats={stats} insights={insights} onOpenIntegrations={()=>setInfo(true)}/>
  {info&&<p>Привяжите Steam в Companion → Настройки → Интеграции. Затем откройте героя заново.</p>}
 </section>;
}
