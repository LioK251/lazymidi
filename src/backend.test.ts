import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
beforeEach(() => { vi.resetModules(); vi.mocked(invoke).mockReset(); });

it("keeps Mapping paused when a dialog closes and resumes after leaving Mapping", async () => {
  const api = await import("./backend");
  const state = api.initialState();
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    if (!args || !("command" in args)) throw new Error("expected a command");
    state.paused = (args.command as { paused: boolean }).paused;
    state.state_sequence++;
    return api.clone(state);
  });
  const mapping = Symbol();
  await api.pauseOutput(mapping, true);
  await expect(api.whilePaused(async () => { throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(state.paused).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  await api.pauseOutput(mapping, false);
  expect(state.paused).toBe(false);
});

it("waits for the pause before opening a dialog and resumes in finally", async () => {
  const api = await import("./backend");
  const state = api.initialState();
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    if (!args || !("command" in args)) throw new Error("expected a command");
    state.paused = (args.command as { paused: boolean }).paused;
    return api.clone(state);
  });
  await api.whilePaused(async () => { expect(state.paused).toBe(true); });
  expect(state.paused).toBe(false);
  expect(invoke).toHaveBeenNthCalledWith(1, "app_command", { command: { type: "pause", paused: true } });
  expect(invoke).toHaveBeenNthCalledWith(2, "app_command", { command: { type: "pause", paused: false } });
});
