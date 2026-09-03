// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import type { DiagnosticsStatusSnapshot } from "../types/status";

afterEach(cleanup);

function buildStatus(overrides: Partial<DiagnosticsStatusSnapshot> = {}): DiagnosticsStatusSnapshot {
  return {
    active: false,
    has_session: false,
    session_id: null,
    started_at: null,
    request_count: 0,
    snapshot_count: 0,
    error_count: 0,
    observed_game_states: [],
    observed_match_ids: [],
    bytes_written: 0,
    size_limit_bytes: 150 * 1024 * 1024,
    size_limit_reached: false,
    tts_trace_count: 0,
    companion_version: "0.5.79",
    os: "windows",
    app_log_size_bytes: 2048,
    ...overrides,
  };
}

describe("DiagnosticsPanel export preview", () => {
  // WK-48 - "состав виден до сохранения": the app.log/runtime-report/
  // version/OS summary must render unconditionally, before the user ever
  // clicks "Экспортировать диагностику (ZIP)" - not gated behind an active
  // or previously-recorded diagnostics session.
  it("shows what the export will contain even with no diagnostics session ever started", () => {
    render(<DiagnosticsPanel status={buildStatus()} refresh={vi.fn()} />);

    expect(screen.getByText("Что войдёт в экспорт")).toBeTruthy();
    expect(screen.getByText("0.5.79")).toBeTruthy();
    expect(screen.getByText("windows")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText(/нет активной или сохранённой сессии/)).toBeTruthy();
  });

  it("shows the session data as included once a session exists", () => {
    render(
      <DiagnosticsPanel
        status={buildStatus({ has_session: true, session_id: "diag_1", started_at: "2026-09-04T00:00:00Z" })}
        refresh={vi.fn()}
      />,
    );

    expect(screen.getByText(/включены \(см\. ниже\)/)).toBeTruthy();
  });

  it("renders nothing about the export composition before the first status arrives", () => {
    render(<DiagnosticsPanel status={null} refresh={vi.fn()} />);

    expect(screen.queryByText("Что войдёт в экспорт")).toBeNull();
  });
});
