import { getHeroById } from "../services/heroCatalog";
import { useState } from "react";
import * as api from "../api";
import { Badge, Button, Checkbox } from "./ui";
import { View } from "./View";

const RESULT:Record<string,string>={win:"Победа",loss:"Поражение",abandon:"Покинул"};
export function HistoryPanel({history,sync,active,reload}:{history:api.History|null;sync:api.SyncStatus|null;active:boolean;reload:()=>Promise<void>}) {
  const [rating,setRating]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);const [result,setResult]=useState<string|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  async function edit(edit:api.HistoryEdit) {
    if(busy||!active)return;
    setBusy(true);setError(null);setResult(null);
    try {
      const context=await api.invoke<api.EditContext>("history.context");
      if(!context.active||!Number.isSafeInteger(context.revision)||context.revision<0)throw new Error("history_context_unavailable");
      const operationKey=`manual:${crypto.randomUUID()}`;
      const receipt=await api.invoke<api.EditReceipt>("history.edit",{operationKey,expectedRevision:context.revision,session:context.session,edit});
      if(receipt.operationKey!==operationKey||!Number.isSafeInteger(receipt.revision)||receipt.beforeRevision!==context.revision||receipt.revision<context.revision)throw new Error("history_receipt_invalid");
      setResult("Изменение сохранено в истории.");setConfirmed(false);
      await reload();
    } catch(e){setError(String(e));}finally{setBusy(false);}
  }
  if(!history)return <section className="dota-view"><View title="История матчей"/><p className="ui-text-muted">Чтение истории…</p></section>;
  const matches=[...(history.currentMatch?[history.currentMatch]:[]),...history.recentMatches];
  const disabled=busy||!active;
  const syncKnown=!!sync&&[sync.pendingCount,sync.retryingCount,sync.failedCount,sync.unknownDeliveryCount].every(n=>Number.isSafeInteger(n)&&n>=0);
  return <section className="dota-view">
    <View title="История матчей" description="Матчи текущей сессии. MMR и тип матча можно поправить вручную."/>
    <div className="history-summary">
      <label className="history-summary__item history-summary__mmr"><span>Текущий MMR</span><input className="inline-number" aria-label="Текущий MMR" type="text" inputMode="numeric" value={rating===null?String(history.ratingCurrent??""):rating} placeholder="не задан" disabled={disabled}
        onFocus={e=>{setRating(String(history.ratingCurrent??""));e.currentTarget.select();}}
        onChange={e=>setRating(e.target.value.replace(/\D/g,"").slice(0,5))}
        onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();if(e.key==="Escape"){setRating(null);e.currentTarget.blur();}}}
        onBlur={()=>{const value=rating;setRating(null);if(value!==null&&value!==""&&Number(value)!==history.ratingCurrent&&Number(value)<=30000)void edit({kind:"rating",rating:Number(value)});}}/></label>
      <span className="history-summary__item"><span>Победы</span><strong className="ui-text-success">{history.wins}</strong></span>
      <span className="history-summary__item"><span>Поражения</span><strong className="ui-text-danger">{history.losses}</strong></span>
      {syncKnown?<span className="history-summary__sync">
        <span>Ожидают отправки: {sync!.pendingCount} · Отклонено сервером: {sync!.failedCount}</span>
        {sync!.unknownDeliveryCount>0&&<span>Результат доставки не подтверждён: {sync!.unknownDeliveryCount}. События сохраняют исходные идентификаторы; история не помечена как отправленная.</span>}
      </span>:<span className="history-summary__sync">Состояние синхронизации недоступно.</span>}
    </div>
    {!active&&<p className="ui-notice ui-notice--warning">Для изменения истории включите плагин.</p>}
    {error&&<p className="ui-notice ui-notice--danger" role="alert">{error} Изменение не повторяется автоматически.</p>}
    {result&&<p className="ui-notice ui-notice--success" role="status">{result}</p>}
    {busy&&<p className="ui-text-muted" role="status">Сохранение…</p>}
    {matches.length===0?<p className="ui-text-muted">Завершённых матчей пока нет.</p>:<div className="history" role="table" aria-label="Матчи">
      <div className="history-row history-row--head" role="row"><span/><span role="columnheader">Герой</span><span role="columnheader">Результат</span><span role="columnheader">Тип</span><span role="columnheader">K/D/A</span><span role="columnheader">Начало</span><span role="columnheader">Ссылки</span><span/></div>
      {matches.map(m=>{const hero=getHeroById(m.heroId);return <article key={m.localId} className="history-row" role="row">
      {hero?<img src={hero.iconUrl} alt="" width={48} height={27} loading="lazy"/>:<span className="history-row__hero"/>}
      <strong>{hero?.localizedName??(m.matchId?`Матч ${m.matchId}`:"Локальный матч")}</strong>
      <span className={`history-row__result history-row__result--${m.result??"unknown"}`}>{RESULT[m.result??""]??(m.state==="finalized"?"Не определён":"Идёт")}</span>
      <span>{m.rankedMode==="ranked"?"Рейтинг":m.rankedMode==="unranked"?"Обычный":"—"}</span>
      <span className="history-row__kda">{m.kills??"—"}/{m.deaths??"—"}/{m.assists??"—"}</span>
      <time>{new Date(m.startedAt).toLocaleString([], {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</time>
      <span className="history-row__links">{m.matchId&&/^\d+$/.test(m.matchId)?<>
        <Button variant="link" size="small" onClick={()=>void api.invoke("link.open",{url:`https://www.dotabuff.com/matches/${m.matchId}`}).catch(()=>undefined)}>Dotabuff</Button>
        <Button variant="link" size="small" onClick={()=>void api.invoke("link.open",{url:`https://www.opendota.com/matches/${m.matchId}`}).catch(()=>undefined)}>OpenDota</Button>
      </>:null}</span>
      {m.state==="finalized"?<details className="ui-disclosure history-row__edit"><summary>Изменить</summary><div className="history-row__edit-menu">
        {typeof m.detectedRatingDelta==="number"&&m.detectedRatingDelta!==0&&Math.abs(m.detectedRatingDelta*2)<=1000&&<Button size="small" disabled={disabled} onClick={()=>void edit({kind:"match_delta",local_id:m.localId,delta:m.detectedRatingDelta!*2})}>MMR ×2</Button>}
        {!!m.ratingDeltaCorrection&&<Button size="small" disabled={disabled} onClick={()=>void edit({kind:"match_delta",local_id:m.localId,delta:null})}>Сбросить поправку MMR</Button>}
        <Button size="small" disabled={disabled} onClick={()=>void edit({kind:"match_mode",local_id:m.localId,ranked:m.rankedMode!=="ranked"})}>{m.rankedMode==="ranked"?"Считать нерейтинговым":"Считать рейтинговым"}</Button>
        {m.rankedMode!==m.rankedModeDetected&&<Button size="small" variant="ghost" disabled={disabled} onClick={()=>void edit({kind:"match_mode",local_id:m.localId,ranked:null})}>Сбросить тип матча</Button>}
      </div></details>:<Badge>Идёт</Badge>}
    </article>;})}</div>}
    {history.hasSession&&<details className="ui-disclosure history-recovery"><summary>Восстановление сессии</summary><div className="ui-disclosure__body">
      <p className="ui-text-soft">Завершайте сессию только вне игры. Автоматическое восстановление не меняет неопределённый результат матча.</p>
      <Checkbox disabled={disabled} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} label="Подтверждаю ручное восстановление"/>
      <div className="ui-button-row">
        <Button disabled={disabled||!confirmed} onClick={()=>void edit({kind:"continue_session"})}>Продолжить сессию</Button>
        <Button variant="danger" disabled={disabled||!confirmed} onClick={()=>void edit({kind:"end_session"})}>Завершить сессию</Button>
        {history.currentMatch&&<Button variant="danger" disabled={disabled||!confirmed} onClick={()=>void edit({kind:"recover_interrupted"})}>Отметить зависший матч прерванным</Button>}
      </div></div></details>}
  </section>;
}
