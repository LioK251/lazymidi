import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import App from "./App";
import { defaultProfile } from "./backend";
import * as api from "./backend";
import { createPauseController } from "./pause";

beforeEach(() => {
  vi.spyOn(api, "pauseOutput").mockImplementation(createPauseController(paused =>
    api.command({ type: "pause", paused }),
  ));
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); });
describe("lazymidi interface", () => {
  it("offers 1000 Hz analog polling and saves it without changing the profile", async () => {
    const initial = api.initialState();
    initial.settings.polling_hz = 500;
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    const command = vi.spyOn(api, "command").mockImplementation(async request => {
      if (request.type === "settings") initial.settings = request.settings as api.Settings;
      return api.clone(initial);
    });
    await act(async () => { render(<App />); });
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Analog polling"), { target: { value: "1000" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply settings" })); });
    const settings = command.mock.calls.find(([request]) => request.type === "settings")![0].settings as api.Settings;
    expect(settings.polling_hz).toBe(1000);
    expect(settings.profiles).toEqual(api.initialState().settings.profiles);
  });
  it("resumes after returning to Play before Mapping's pause reply", async () => {
    const initial = { ...api.initialState(), analog_enabled: true, qwerty_enabled: true };
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    let completePause: (() => void) | undefined;
    const command = vi.spyOn(api, "command").mockImplementation(request => {
      if (request.type === "pause" && request.paused)
        return new Promise(resolve => {
          completePause = () => resolve({ ...initial, paused: true, state_sequence: 1 });
        });
      return Promise.resolve({ ...initial, paused: false, state_sequence: 2 });
    });
    await act(async () => { render(<App />); });
    fireEvent.click(screen.getByRole("tab", { name: "Mapping" }));
    await waitFor(() => expect(completePause).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("tab", { name: "Play" }));
    await act(async () => { completePause!(); });
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: "pause", paused: false }));
    expect(screen.queryByRole("button", { name: "Resume generated keys" })).toBeNull();
    expect((screen.getByRole("switch", { name: "MIDI → QWERTY" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("switch", { name: "Enable analog input" }) as HTMLInputElement).checked).toBe(true);
  });
  it("ignores a delayed snapshot older than the current module state", async () => {
    const initial = { ...api.initialState(), state_sequence: 10, analog_enabled: true, qwerty_enabled: true };
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    let publish: ((s: api.Snapshot) => void) | undefined;
    vi.spyOn(api, "subscribe").mockImplementation(async callback => { publish = callback; return () => {}; });
    await act(async () => { render(<App />); });
    await act(async () => { publish!({ ...initial, state_sequence: 9, analog_enabled: false, qwerty_enabled: false }); });
    expect((screen.getByRole("switch", { name: "MIDI → QWERTY" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("switch", { name: "Enable analog input" }) as HTMLInputElement).checked).toBe(true);
  });
  it("ignores an old command reply after a newer state event", async () => {
    const initial = { ...api.initialState(), state_sequence: 10, analog_enabled: true, qwerty_enabled: true };
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    let publish: ((s: api.Snapshot) => void) | undefined;
    let finish: (() => void) | undefined;
    vi.spyOn(api, "subscribe").mockImplementation(async callback => { publish = callback; return () => {}; });
    vi.spyOn(api, "command").mockImplementation(() => new Promise(resolve => { finish = () => resolve(initial); }));
    await act(async () => { render(<App />); });
    fireEvent.click(screen.getByRole("switch", { name: "MIDI → QWERTY" }));
    await act(async () => { publish!({ ...initial, state_sequence: 11, qwerty_enabled: false }); finish!(); });
    expect((screen.getByRole("switch", { name: "MIDI → QWERTY" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("switch", { name: "Enable analog input" }) as HTMLInputElement).checked).toBe(true);
  });
  it("resumes after an editor loses focus before its pause reply", async () => {
    const initial = { ...api.initialState(), analog_enabled: true, qwerty_enabled: true };
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    let completePause: (() => void) | undefined;
    const command = vi.spyOn(api, "command").mockImplementation(request => {
      if (request.paused) return new Promise(resolve => { completePause = () => resolve({ ...initial, paused: true, state_sequence: 1 }); });
      return Promise.resolve({ ...initial, paused: false, state_sequence: 2 });
    });
    await act(async () => { render(<App />); });
    const field = screen.getByLabelText("Analog shift amount");
    fireEvent.focus(field);
    await waitFor(() => expect(completePause).toBeTypeOf("function"));
    fireEvent.blur(field, { relatedTarget: screen.getByRole("button", { name: "Panic" }) });
    await act(async () => { completePause!(); });
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: "pause", paused: false }));
    expect(screen.queryByRole("button", { name: "Resume generated keys" })).toBeNull();
    expect((screen.getByRole("switch", { name: "Enable analog input" }) as HTMLInputElement).checked).toBe(true);
  });
  it("keeps the exact analog preset and independent inverse mapping", () => {
    const p = defaultProfile();
    expect(p.analog.shift_amount).toBe(1);
    expect(p.analog.note_config).toEqual({ threshold: 0.5, velocity_scale: 1 });
    expect(p.qwerty).toHaveLength(36);
    for (const binding of p.qwerty)
      expect(p.analog.keymapping[String(binding.channel)]).toContainEqual([
        binding.hid,
        binding.note,
      ]);
  });
  it("starts generated keys off and reports unavailable native output in a browser", async () => {
    await act(async () => { render(<App />); });
    const toggle = screen.getByRole("switch", { name: "MIDI → QWERTY" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("desktop app"),
    );
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });
  it("edits a profile as a draft, applies it, and restores the supplied defaults", async () => {
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Mapping" })); });
    fireEvent.change(screen.getByLabelText("Mapping direction"), {
      target: { value: "qwerty" },
    });
    const note = screen.getByLabelText("Note for binding 1");
    fireEvent.change(note, { target: { value: "37" } });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Apply profile" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply profile" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Apply profile" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore default mappings" }),
    );
    expect(
      (screen.getByLabelText("Note for binding 1") as HTMLInputElement).value,
    ).toBe("21");
  });
  it("assigns an analog physical key through the 88-key piano editor", async () => {
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Mapping" })); });
    fireEvent.change(screen.getByLabelText("Mapping direction"), {
      target: { value: "analog" },
    });
    const keys = screen.getByRole("group", { name: "Piano notes A0 to C8" });
    expect(keys.querySelectorAll("button")).toHaveLength(88);
    fireEvent.click(screen.getByRole("button", { name: /^C4 MIDI 60/ }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Capture key" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Capture key" }));
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Press a physical key…" }),
      { code: "KeyZ", key: "z" },
    );
    expect(
      screen.getByRole("button", { name: /^C4 MIDI 60, mapped to Z/ }),
    ).toBeTruthy();
    const key = screen.getByRole("button", { name: /^C4 MIDI 60, mapped to Z/ });
    expect(key.children[0].textContent).toBe("C4");
    expect(key.children[1].textContent).toBe("Z");
    expect(screen.queryByText(/click a note to assign/)).toBeNull();
    expect(screen.queryByText("Keyboard & MIDI")).toBeNull();
  });
  it("hides sequencing and shows editable response controls only for enabled analog input", async () => {
    const initial = api.initialState();
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    const view = await act(async () => render(<App />));
    expect(screen.queryByRole("tab", { name: "Sequencer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open sequencer" })).toBeNull();
    expect(screen.queryByLabelText("Analog shift amount")).toBeNull();
    view.unmount();
    initial.analog_enabled = true;
    initial.qwerty_enabled = true;
    initial.warning = null;
    const command = vi.spyOn(api, "command").mockImplementation(async (request) => request.type === "pause" ? ({
      ...initial, paused: Boolean(request.paused),
    }) : ({
      ...initial,
      settings: request.settings as api.Settings,
      revision: 1,
      qwerty_enabled: false,
    }));
    await act(async () => { render(<App />); });
    expect((screen.getByLabelText("Analog shift amount") as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByLabelText("Analog shift amount"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Analog note threshold"), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Analog velocity scale"), { target: { value: "0.62" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply analog settings" })); });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: "settings", expected_revision: 0 }));
    const settings = command.mock.calls.find(([request]) => request.type === "settings")![0].settings as api.Settings;
    const analog = settings.profiles.find(p => p.id === settings.selected_profile)!.analog;
    expect(analog.shift_amount).toBe(2);
    expect(analog.note_config).toEqual({ threshold: 0.25, velocity_scale: 0.62 });
    expect(screen.queryByLabelText("Analog velocity scale")).not.toBeNull();
    expect((screen.getByRole("switch", { name: "MIDI → QWERTY" }) as HTMLInputElement).checked).toBe(false);
  });
  it("edits output toggles in both mapping modes and applies them without deleting mappings", async () => {
    const initial = api.initialState();
    initial.qwerty_enabled = true;
    initial.settings.profiles[1].sustain_hid = 43;
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    const command = vi.spyOn(api, "command").mockImplementation(async (request) => {
      if (request.type === "settings") {
        initial.settings = request.settings as api.Settings;
        initial.revision++;
        initial.qwerty_enabled = false;
      }
      return api.clone(initial);
    });
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Mapping" })); });
    const direction = screen.getByLabelText("Mapping direction");
    fireEvent.change(direction, { target: { value: "analog" } });
    for (const label of ["Velocity", "Sustain", "88 Keys"])
      expect((screen.getByRole("switch", { name: label }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Sustain" }));
    fireEvent.click(screen.getByRole("switch", { name: "Sustain" }));
    fireEvent.click(screen.getByRole("switch", { name: "Sustain" }));
    fireEvent.click(screen.getByRole("switch", { name: "Velocity" }));
    fireEvent.click(screen.getByRole("switch", { name: "88 Keys" }));
    expect(screen.getByRole("group", { name: "Piano notes A0 to C8" }).querySelectorAll("button")).toHaveLength(88);
    fireEvent.change(direction, { target: { value: "qwerty" } });
    for (const label of ["Velocity", "Sustain", "88 Keys"])
      expect((screen.getByRole("switch", { name: label }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply profile" })); });
    const settings = command.mock.calls.find(([request]) => request.type === "settings")![0].settings as api.Settings;
    const profile = settings.profiles.find(p => p.id === settings.selected_profile)!;
    expect(profile).toMatchObject({ game_velocity: false, sustain_enabled: false, extended_keys: false, sustain_hid: 43 });
    expect(profile.qwerty).toEqual(initial.settings.profiles[1].qwerty);
    expect(profile.analog).toEqual(initial.settings.profiles[1].analog);
    expect(profile.qwerty).toHaveLength(88);
    expect((screen.getByRole("switch", { name: "88 Keys" }) as HTMLInputElement).checked).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Play" })); });
    expect((screen.getByRole("switch", { name: "MIDI → QWERTY" }) as HTMLInputElement).checked).toBe(false);
  });
  it("defaults a new sustain binding to Space and disables velocity without the game protocol", async () => {
    const initial = api.initialState();
    initial.settings.selected_profile = "default-copy";
    vi.spyOn(api, "getState").mockResolvedValue(initial);
    const command = vi.spyOn(api, "command").mockImplementation(async (request) => {
      if (request.type === "settings") {
        initial.settings = request.settings as api.Settings;
        initial.revision++;
      }
      return api.clone(initial);
    });
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Mapping" })); });
    expect((screen.getByRole("switch", { name: "Velocity" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Sustain" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Sustain" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply profile" })); });
    const settings = command.mock.calls.find(([request]) => request.type === "settings")![0].settings as api.Settings;
    expect(settings.profiles[0]).toMatchObject({ sustain_enabled: true, sustain_hid: 44 });
  });
});
