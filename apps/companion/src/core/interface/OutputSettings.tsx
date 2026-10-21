import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import type { AudioOutputDeviceState } from "../../hooks/useAudioOutputDevice";
import { Notice, Panel, RangeField, Select, SettingsGroup, SettingsRow } from "../../components/ui";

export function OutputSettings({session,output,volume,onVolume}: {session:TwitchChatSession;output:AudioOutputDeviceState;volume:number;onVolume:(v:number)=>void}) {
  const current=output.selection.mode==="system-default"?"system-default":output.selection.deviceId;
  return <Panel title="Вывод звука" description="Куда Companion выводит речь, звуки чата и звуки расширений. Системный звук и OBS не изменяются.">
    <SettingsGroup>
      <SettingsRow stacked label="Устройство вывода">
        <Select aria-label="Устройство вывода" className="output-settings__device" value={current} onChange={(e)=>{
          if(e.target.value==="system-default"){output.setSelection({mode:"system-default"});return;}
          const device=output.devices.find((d)=>d.deviceId===e.target.value);
          if(device)output.setSelection({mode:"explicit",deviceId:device.deviceId,label:device.label});
        }}>
          <option value="system-default">Системное устройство по умолчанию</option>
          {output.devices.map((d)=><option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          {output.selection.mode==="explicit"&&output.selectedDeviceMissing&&<option value={output.selection.deviceId}>{output.selectedDeviceLabel} (недоступно)</option>}
        </Select>
      </SettingsRow>
      {output.selectedDeviceMissing&&<Notice tone="warning">Выбранное устройство недоступно. Используется резервное устройство.</Notice>}
      <SettingsRow label="Общая громкость" description="Речь и звуки расширений">
        <span className="output-settings__range"><RangeField aria-label="Общая громкость" display={`${volume}%`} min={0} max={100} value={volume} onChange={(e)=>onVolume(Number(e.target.value))}/></span>
      </SettingsRow>
      <SettingsRow label="Громкость речи" description="Относительно общей громкости">
        <span className="output-settings__range"><RangeField aria-label="Громкость речи" display={`${session.settings.speechVolume}%`} min={0} max={100} value={session.settings.speechVolume} onChange={(e)=>session.updateSetting("speechVolume",Number(e.target.value))}/></span>
      </SettingsRow>
    </SettingsGroup>
  </Panel>;
}
