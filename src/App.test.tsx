import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("lazymidi interface", () => {
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
    const command = vi.spyOn(api, "command").mockImplementation(async (request) => ({
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
    const settings = command.mock.calls[0][0].settings as api.Settings;
    const analog = settings.profiles.find(p => p.id === settings.selected_profile)!.analog;
    expect(analog.shift_amount).toBe(2);
    expect(analog.note_config).toEqual({ threshold: 0.25, velocity_scale: 0.62 });
    expect(screen.queryByLabelText("Analog velocity scale")).not.toBeNull();
    expect((screen.getByRole("switch", { name: "MIDI → QWERTY" }) as HTMLInputElement).checked).toBe(false);
  });
});
