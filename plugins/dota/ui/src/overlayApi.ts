import { invoke, type History } from "./api";
import type { OverlayLayoutDoc, QueueSettingsDoc } from "./overlayTypes";
interface Request { resource:string; operationKey:string; query:Record<string,string>; body:unknown }
interface Result {status:string;response?:{status:number|null;body:unknown;error:string|null}|null}
interface Pending {operationKey:string;action:{kind:"backend_setting";request:Request}}
const verify=<T,>(result:Result):T=>{
 if(result.status==="unknown")throw Error("backend_result_unknown: результат сохранения не подтверждён. Проверьте состояние на сервере; запись не повторяется автоматически.");
 if(result.status!=="completed"||result.response?.error||!result.response?.status||result.response.status<200||result.response.status>=300||typeof result.response.body!=="object"||!result.response.body)throw Error(result.response?.error??"backend_settings_unconfirmed");
 return result.response.body as T;
};
let pending=0;let backendTail:Promise<unknown>=Promise.resolve();
function backendCall<T>(perform:()=>Promise<T>):Promise<T>{
 if(pending>=8)return Promise.reject(Error("backend_ui_queue_full"));pending++;
 const task=backendTail.then(perform);backendTail=task.catch(()=>undefined);
 return task.finally(()=>{pending--;});
}
export const readBackendResource=<T,>(resource:string,query:Record<string,string>={})=>backendCall(()=>invoke<Result>("backend.request",{request:{resource,operationKey:`read:${crypto.randomUUID()}`,query,body:null}}).then(verify<T>));
const read=readBackendResource;
const save=<T,>(resource:string,body:T)=>backendCall(()=>invoke<Result>("backend.request",{request:{resource,operationKey:`setting:${crypto.randomUUID()}`,query:{},body}}).then(verify<T>));
export const getOverlayLayout=()=>read<OverlayLayoutDoc>("overlay-layout");
export const saveOverlayLayout=(layout:OverlayLayoutDoc)=>save("overlay-layout-save",layout);
export const getQueueSettings=()=>read<QueueSettingsDoc>("queue-settings");
export const saveQueueSettings=(settings:QueueSettingsDoc)=>save("queue-settings-save",settings);
export const getLocalSessionSummary=()=>invoke<History>("history.summary");
export const pendingSettings=()=>invoke<Pending|null>("backend.pending");
export async function reconcileSettings(pending:Pending):Promise<void>{
 const resource=pending.action.request.resource;
 const readResource=resource==="overlay-layout-save"?"overlay-layout":resource==="queue-settings-save"?"queue-settings":null;
 if(!readResource)throw Error("backend_reconciliation_scope_mismatch");
 verify(await invoke<Result>("backend.reconcile",{readResource}));
}
async function chooseImage(kind:"webcam"|"reference"):Promise<string>{
 try{
  const asset=await invoke<{fileName:string}>("image.import");
  const result=await invoke<{url:string|null}>("overlay.image.apply",{kind,fileName:asset.fileName});
  if(!result.url)throw Error("overlay_image_unconfirmed");return result.url;
 }catch(error){if(String(error).includes("file_selection_cancelled"))throw Error("Выбор изображения отменён.");throw error;}
}
export const chooseQueueWebcamFallback=()=>chooseImage("webcam");
export const removeQueueWebcamFallback=()=>invoke("overlay.image.remove",{kind:"webcam"});
export const chooseGameplayReference=()=>chooseImage("reference");
export const getGameplayReference=()=>invoke<{url:string|null}>("overlay.image.get",{kind:"reference"}).then(result=>result.url);
export const removeGameplayReference=()=>invoke("overlay.image.remove",{kind:"reference"});
export const getReferenceOpacity=()=>invoke<{opacity:number}>("overlay.reference",{}).then(result=>result.opacity);
export const saveReferenceOpacity=(opacity:number)=>invoke<{opacity:number}>("overlay.reference.save",{opacity}).then(result=>result.opacity);
