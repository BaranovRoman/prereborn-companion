import { useState } from "react";
import * as api from "../api";

export function HistoryPanel({history,sync,active,reload}:{history:api.History|null;sync:api.SyncStatus|null;active:boolean;reload:()=>Promise<void>}) {
  const [rating,setRating]=useState("");const [busy,setBusy]=useState(false);
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
  if(!history)return <section><h2>История матчей</h2><p>Чтение истории…</p></section>;
  const matches=[...(history.currentMatch?[history.currentMatch]:[]),...history.recentMatches];
  const disabled=busy||!active;
  return <section><h2>История матчей</h2>
    <p>Текущий MMR: {history.ratingCurrent??"не задан"} · Победы: {history.wins} · Поражения: {history.losses}</p>
    {sync&&[sync.pendingCount,sync.retryingCount,sync.failedCount,sync.unknownDeliveryCount].every(n=>Number.isSafeInteger(n)&&n>=0)?<div>
      <p>Ожидают отправки: {sync.pendingCount} · Отклонено сервером: {sync.failedCount}</p>
      {sync.unknownDeliveryCount>0&&<p>Результат доставки не подтверждён: {sync.unknownDeliveryCount}. События сохраняют исходные идентификаторы; история не помечена как отправленная.</p>}
    </div>:<p>Состояние синхронизации недоступно.</p>}
    {!active&&<p>Для изменения истории включите плагин.</p>}
    <form onSubmit={e=>{e.preventDefault();if(rating.trim()!==""&&Number.isInteger(Number(rating)))void edit({kind:"rating",rating:Number(rating)});}}>
      <label>Текущий MMR <input type="number" min="0" max="30000" step="1" value={rating} disabled={disabled} onChange={e=>setRating(e.target.value)}/></label>
      <button disabled={disabled||rating.trim()===""} type="submit">Сохранить MMR</button>
    </form>
    {error&&<p role="alert">{error} Изменение не повторяется автоматически.</p>}
    {result&&<p role="status">{result}</p>}
    {busy&&<p role="status">Сохранение…</p>}
    {matches.length===0?<p>Завершённых матчей пока нет.</p>:<div className="history">{matches.map(m=><article key={m.localId}>
      <strong>{m.matchId?`Матч ${m.matchId}`:"Локальный матч"}</strong><p>{m.state} · {m.result??"результат не определён"}</p>
      <p>K/D/A: {m.kills??"—"}/{m.deaths??"—"}/{m.assists??"—"}</p><time>{new Date(m.startedAt).toLocaleString()}</time>
      {m.state==="finalized"&&<div className="sound-binding-row__actions">
        {typeof m.detectedRatingDelta==="number"&&m.detectedRatingDelta!==0&&Math.abs(m.detectedRatingDelta*2)<=1000&&<button disabled={disabled} onClick={()=>void edit({kind:"match_delta",local_id:m.localId,delta:m.detectedRatingDelta!*2})}>MMR ×2</button>}
        {!!m.ratingDeltaCorrection&&<button disabled={disabled} onClick={()=>void edit({kind:"match_delta",local_id:m.localId,delta:null})}>Сбросить поправку MMR</button>}
        <button disabled={disabled} onClick={()=>void edit({kind:"match_mode",local_id:m.localId,ranked:m.rankedMode!=="ranked"})}>{m.rankedMode==="ranked"?"Считать нерейтинговым":"Считать рейтинговым"}</button>
        {m.rankedMode!==m.rankedModeDetected&&<button disabled={disabled} onClick={()=>void edit({kind:"match_mode",local_id:m.localId,ranked:null})}>Сбросить тип матча</button>}
      </div>}
    </article>)}</div>}
    {history.hasSession&&<details><summary>Восстановление сессии</summary><p>Завершайте сессию только вне игры. Автоматическое восстановление не меняет неопределённый результат матча.</p>
      <label><input type="checkbox" disabled={disabled} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Подтверждаю ручное восстановление</label>
      <div className="sound-binding-row__actions">
        <button disabled={disabled||!confirmed} onClick={()=>void edit({kind:"continue_session"})}>Продолжить сессию</button>
        <button disabled={disabled||!confirmed} onClick={()=>void edit({kind:"end_session"})}>Завершить сессию</button>
        {history.currentMatch&&<button disabled={disabled||!confirmed} onClick={()=>void edit({kind:"recover_interrupted"})}>Отметить зависший матч прерванным</button>}
      </div></details>}
  </section>;
}
