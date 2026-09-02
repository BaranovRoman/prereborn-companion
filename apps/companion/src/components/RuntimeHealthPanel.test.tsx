// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHealthPanel } from "./RuntimeHealthPanel";
import type { HealthComponent, RuntimeHealth } from "../types/status";

afterEach(cleanup);

function component(overrides: Partial<HealthComponent> = {}): HealthComponent {
  return { status: "healthy", reason: null, lastSuccessAt: null, lastErrorAt: null, ...overrides };
}

function health(overrides: Partial<RuntimeHealth> = {}): RuntimeHealth {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-02T10:00:00+03:00",
    app: { version: "0.5.69", platform: "windows" },
    localRuntime: {
      status: "healthy",
      gsi: component(),
      localSession: component(),
      sqlite: component(),
      overlayServer: component(),
    },
    integrations: {
      status: "healthy",
      obs: component({ status: "disabled" }),
      obsSceneAutomation: component({ status: "disabled" }),
      twitch: component({ status: "unknown" }),
      tts: component({ status: "disabled" }),
      gameSounds: component({ status: "disabled" }),
    },
    cloud: {
      status: "healthy",
      backend: component(),
      sync: component(),
      account: component({ status: "disabled" }),
    },
    ...overrides,
  };
}

describe("RuntimeHealthPanel", () => {
  it("renders nothing while no health snapshot has loaded yet", () => {
    const { container } = render(<RuntimeHealthPanel health={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows no reason text for healthy or disabled components - a calm panel stays calm", () => {
    render(<RuntimeHealthPanel health={health()} />);
    // Disabled components render (Twitch: unknown, OBS: disabled, ...) but
    // never with a visible reason string next to them.
    expect(screen.queryByText(/no data|not observed|turned off/i)).toBeNull();
  });

  it("surfaces the reason text for a degraded or unavailable component", () => {
    const h = health({
      cloud: {
        status: "degraded",
        backend: component(),
        sync: component({ status: "degraded", reason: "2 event(s) permanently rejected by the backend" }),
        account: component({ status: "disabled" }),
      },
    });
    render(<RuntimeHealthPanel health={h} />);
    expect(screen.getByText(/permanently rejected/i)).not.toBeNull();
  });

  it("renders all three groups by their canonical Russian labels", () => {
    render(<RuntimeHealthPanel health={health()} />);
    expect(screen.getByText("Локальный runtime")).not.toBeNull();
    expect(screen.getByText("Интеграции")).not.toBeNull();
    expect(screen.getByText("Облако")).not.toBeNull();
  });
});
