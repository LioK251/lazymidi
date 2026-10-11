import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
beforeEach(() => { vi.resetModules(); vi.mocked(invoke).mockReset(); });

it("saves sheet transposes without changing bindings or musical switches",async()=>{
  const api=await import("./backend");const state=api.initialState();state.analog_enabled=true;state.qwerty_enabled=true;
  const profile=state.settings.profiles.find(p=>p.id===state.settings.selected_profile)!;
  profile.transpose.up=82;profile.transpose.down=81;state.transpose.armed=true;state.transpose.selected=3;
  vi.mocked(invoke).mockImplementation(async(name,args)=>{
    if(name==="get_state")return api.clone(state);
    const request=(args as {command:Record<string,unknown>}).command;
    if(request.type==="settings"){expect(request.expected_revision).toBe(state.revision);state.settings=request.settings as typeof state.settings;state.revision++;}
    if(request.action==="pause")state.transpose.armed=false;
    if(request.action==="select")state.transpose.selected=Number(request.index);
    if(request.action==="arm")state.transpose.armed=true;
    state.state_sequence++;return api.clone(state);
  });
  const result=await api.sendTransposeSequence([4,-3,-3,0]);
  expect(result.settings.profiles.find(p=>p.id===result.settings.selected_profile)!.transpose).toEqual({...profile.transpose,sequence:[4,-3,-3,0]});
  expect(result.transpose.armed).toBe(true);expect(result.transpose.selected).toBe(0);
  expect(result.analog_enabled&&result.qwerty_enabled).toBe(true);
  for(const values of [[],[51],[1.5],Array(513).fill(0)])await expect(api.sendTransposeSequence(values)).rejects.toThrow("1–512");
  expect(invoke).toHaveBeenCalledTimes(5);
});

it("resumes on monitor open or reopen only with bindings and while paused",async()=>{
  const api=await import("./backend");const state=api.initialState();
  const profile=state.settings.profiles.find(p=>p.id===state.settings.selected_profile)!;
  vi.mocked(invoke).mockImplementation(async(name,args)=>{
    if(name==="app_command"){expect((args as {command:unknown}).command).toEqual({type:"transpose",action:"arm"});state.transpose.armed=true;}
    return api.clone(state);
  });
  await api.openOverlay("monitor");
  expect(state.transpose.armed).toBe(false);
  profile.transpose.up=82;profile.transpose.down=81;
  await api.openOverlay("monitor");expect(state.transpose.armed).toBe(true);
  const sent=vi.mocked(invoke).mock.calls.filter(([name])=>name==="app_command").length;
  await api.openOverlay("monitor");await api.openOverlay("sheet");
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==="app_command")).toHaveLength(sent);
  state.transpose.armed=false;await api.openOverlay("monitor");expect(state.transpose.armed).toBe(true);
});

it("saves sheet transposes without resuming when bindings are missing",async()=>{
  const api=await import("./backend");const state=api.initialState();
  vi.mocked(invoke).mockImplementation(async(_name,args)=>{
    const request=(args as {command?:Record<string,unknown>})?.command;
    if(request?.type==="settings")state.settings=request.settings as typeof state.settings;
    expect(request?.action).not.toBe("arm");return state;
  });
  const result=await api.sendTransposeSequence([4,-3]);
  expect(result.transpose.armed).toBe(false);
});

it("does not pause or select after a stale sheet-transfer save is rejected",async()=>{
  const api=await import("./backend");vi.mocked(invoke).mockImplementation(async name=>{
    if(name==="get_state")return api.initialState();throw new Error("Preferences changed");
  });
  await expect(api.sendTransposeSequence([0])).rejects.toThrow("Preferences changed");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("does not replace a sequence during unfinished native delivery",async()=>{
  const api=await import("./backend");const state=api.initialState();state.transpose.busy=true;
  vi.mocked(invoke).mockResolvedValue(state);
  await expect(api.sendTransposeSequence([4])).rejects.toThrow("Wait for the current transpose");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("can save sheet transposes while the Transposer tab is hidden",async()=>{
  const api=await import("./backend");const state=api.initialState();state.settings.show_transposer=false;
  vi.mocked(invoke).mockImplementation(async(name,args)=>{
    if(name==="get_state")return state;
    const request=(args as {command:{type:string;settings:typeof state.settings}}).command;
    expect(request.type).toBe("settings");state.settings=request.settings;return state;
  });
  await api.sendTransposeSequence([4,-3,-3]);expect(invoke).toHaveBeenCalledTimes(2);
});

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
