// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemBar, type AudioOutputProblemState } from "./ProblemBar";
import type { LifecycleStatus, StatusSnapshot } from "../types/status";
import type { BackendStatusDescription } from "../utils/backendStatus";

function buildStatus(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    dota_found: true,
    dota_path: null,
    dota_source: null,
    gsi_installed: true,
    gsi_config_path: null,
    server_running: true,
    gsi_state: "connected",
    gsi_last_error: null,
    server_port: 3600,
    request_count: 0,
    last_event: null,
    log_dir: null,
    legacy_cleanup_in_progress: false,
    backend_url: "https://prereborn.ru/api",
    companion_token_configured: true,
    backend_state: "connected",
    backend_last_sent_at: null,
    backend_last_error: null,
    obs_config: {
      enabled: true, host: "localhost", port: 4455, password: "",
      between_matches_scene: "", draft_scene: "", gameplay_scene: "", post_stream_scene: "",
    },
    obs_connected: true,
    obs_state: "connected",
    obs_active_scene: null,
    obs_last_error: null,
    obs_streaming: true,
    obs_manual_summary_active: false,
    overlay_visible: true,
    overlay_server_running: true,
    overlay_state: "connected",
    overlay_last_error: null,
    companion_version: "0.5.0",
    ...overrides,
  } as StatusSnapshot;
}

const OK_BACKEND_STATUS: BackendStatusDescription = { tone: "ok", label: "", detail: "" };

function buildLifecycle(overrides: Partial<LifecycleStatus> = {}): LifecycleStatus {
  return {
    session_state: "none",
    session_started_at: null,
    pending_end_at: null,
    obs_streaming: true,
    obs_streaming_confirmed_at: null,
    awaiting_start_confirmation: false,
    ...overrides,
  };
}

function buildAudioOutput(overrides: Partial<AudioOutputProblemState> = {}): AudioOutputProblemState {
  return {
    selectedDeviceMissing: false,
    selectedDeviceLabel: null,
    defaultDeviceChangedNotice: null,
    onDismissDefaultDeviceChangedNotice: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("ProblemBar - reliability follow-up", () => {
  it("renders nothing when lifecycle/audioOutput are omitted and the base status is healthy", () => {
    const { container } = render(<ProblemBar status={buildStatus()} backendStatus={OK_BACKEND_STATUS} syncStatus={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a persistent warning while OBS is in the pending_end grace window", () => {
    render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        lifecycle={buildLifecycle({ session_state: "pending_end" })}
      />
    );
    expect(screen.getByText("Стрим неожиданно остановился")).toBeTruthy();
  });

  it("shows a warning when GSI shows Draft/Gameplay but OBS never confirmed streaming", () => {
    render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        lifecycle={buildLifecycle({ session_state: "none", awaiting_start_confirmation: true })}
      />
    );
    expect(screen.getByText("OBS не подтвердил трансляцию")).toBeTruthy();
  });

  it("gives pending_end precedence over awaiting_start_confirmation when both are true", () => {
    render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        lifecycle={buildLifecycle({ session_state: "pending_end", awaiting_start_confirmation: true })}
      />
    );
    expect(screen.getByText("Стрим неожиданно остановился")).toBeTruthy();
    expect(screen.queryByText("OBS не подтвердил трансляцию")).toBeNull();
  });

  it("shows nothing for a normal, already-finalized stop (session_state none, not awaiting confirmation)", () => {
    const { container } = render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        lifecycle={buildLifecycle({ session_state: "none", awaiting_start_confirmation: false })}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("does not surface needs_manual_recovery here (owned by LocalStreamLifecycleCard instead)", () => {
    const { container } = render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        lifecycle={buildLifecycle({ session_state: "needs_manual_recovery" })}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a critical warning when the selected explicit audio device is missing", () => {
    render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        audioOutput={buildAudioOutput({ selectedDeviceMissing: true, selectedDeviceLabel: "USB Headset" })}
      />
    );
    expect(screen.getByText("Выбранное аудиоустройство недоступно")).toBeTruthy();
    expect(screen.getByText(/USB Headset/)).toBeTruthy();
  });

  it("shows a dismissible info notice when the system default changed (no missing device)", () => {
    const onDismiss = vi.fn();
    render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        audioOutput={buildAudioOutput({ defaultDeviceChangedNotice: "Системный вывод сменился на «Headset».", onDismissDefaultDeviceChangedNotice: onDismiss })}
      />
    );
    expect(screen.getByText("Системный вывод сменился на «Headset».")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Скрыть"));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("prefers the missing-device warning over the default-changed notice when both are present", () => {
    render(
      <ProblemBar
        status={buildStatus()}
        backendStatus={OK_BACKEND_STATUS}
        syncStatus={null}
        audioOutput={buildAudioOutput({
          selectedDeviceMissing: true,
          selectedDeviceLabel: "USB Headset",
          defaultDeviceChangedNotice: "Системный вывод сменился на «Headset».",
        })}
      />
    );
    expect(screen.getByText("Выбранное аудиоустройство недоступно")).toBeTruthy();
    expect(screen.queryByText("Системное аудиоустройство изменилось")).toBeNull();
  });
});
