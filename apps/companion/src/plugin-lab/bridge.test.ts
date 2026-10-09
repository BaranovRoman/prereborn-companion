import { describe, expect, it } from "vitest";
import { greeting } from "./bridge";
describe("iframe bridge", () => {
  it("accepts only greetings from the registered frame, with a bounded payload", () => {
    const source = {} as Window;
    const event = (data: unknown, sender = source) => ({ source: sender, data }) as MessageEvent;
    expect(greeting(event({ type: "hello-greet", text: "World" }), source)).toBe("World");
    expect(greeting(event({ type: "hello-greet", text: "x".repeat(1000) }), source)).toHaveLength(100);
    expect(greeting(event({ type: "hello-greet", text: "World" }, {} as Window), source)).toBeNull();
    expect(greeting(event({ type: "shell", text: "World" }), source)).toBeNull();
    expect(greeting(event({ type: "hello-greet", text: {} }), source)).toBeNull();
  });
});
