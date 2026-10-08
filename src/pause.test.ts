import { describe, expect, it, vi } from "vitest";
import { createPauseController } from "./pause";

describe("output pause coordination", () => {
  it("serializes rapid transitions and preserves overlapping editor/dialog reasons", async () => {
    let finish: (() => void) | undefined;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const pause = createPauseController(send);
    const mapping = Symbol(), editor = Symbol(), dialog = Symbol();
    const started = pause(mapping, true);
    await Promise.resolve();
    await Promise.resolve();
    const leaving = pause(mapping, false);
    const editing = pause(editor, true);
    const opening = pause(dialog, true);
    const closing = pause(dialog, false);
    expect(send.mock.calls).toEqual([[true]]);
    finish!();
    await Promise.all([started, leaving, editing, opening, closing]);
    expect(send.mock.calls).toEqual([[true], [false], [true]]);
    await pause(editor, false);
    expect(send.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
  it("recovers from a failed request and never resumes while another reason remains", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
    const pause = createPauseController(send);
    const mapping = Symbol(), dialog = Symbol();
    await expect(pause(mapping, true)).rejects.toThrow("unavailable");
    await pause(mapping, true);
    await pause(dialog, true);
    await pause(dialog, false);
    expect(send.mock.calls).toEqual([[true], [true]]);
    await pause(mapping, false);
    expect(send.mock.calls.at(-1)).toEqual([false]);
  });
});
