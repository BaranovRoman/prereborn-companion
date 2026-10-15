import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import type { AudioOutputDeviceState } from "../../hooks/useAudioOutputDevice";
import { Slider } from "../../components/ui";

export function OutputSettings({session,output,volume,onVolume}: {session:TwitchChatSession;output:AudioOutputDeviceState;volume:number;onVolume:(v:number)=>void}) {
  return <section className="core-settings-group">
    <h2>Вывод звука</h2>
    <label>Устройство вывода<select value={output.selection.mode==="system-default"?"system-default":output.selection.deviceId} onChange={(e)=>{
      if(e.target.value==="system-default"){output.setSelection({mode:"system-default"});return;}
      const device=output.devices.find((d)=>d.deviceId===e.target.value);
      if(device)output.setSelection({mode:"explicit",deviceId:device.deviceId,label:device.label});
    }}>
      <option value="system-default">Системное устройство по умолчанию</option>
      {output.devices.map((d)=><option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
      {output.selection.mode==="explicit"&&output.selectedDeviceMissing&&<option value={output.selection.deviceId}>{output.selectedDeviceLabel} (недоступно)</option>}
    </select></label>
    {output.selectedDeviceMissing&&<p role="status">Выбранное устройство недоступно. Используется резервное устройство.</p>}
    <label>Общая громкость · {volume}%<Slider min={0} max={100} value={volume} onChange={(e)=>onVolume(Number(e.target.value))}/></label>
    <label>Громкость речи · {session.settings.speechVolume}%<Slider min={0} max={100} value={session.settings.speechVolume} onChange={(e)=>session.updateSetting("speechVolume",Number(e.target.value))}/></label>
    <p className="core-hint">Общая громкость применяется к речи и звукам расширений. Системный звук и OBS не изменяются.</p>
  </section>;
}
