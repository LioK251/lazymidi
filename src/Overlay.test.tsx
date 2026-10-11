import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {invoke} from "@tauri-apps/api/core";
import type {SheetContent} from "./converter-api";
import Overlay from "./Overlay";
import * as api from "./backend";

let sheetEvent:(event:{payload:SheetContent})=>void=()=>{};
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(),isTauri:()=>false}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async(_name,listener)=>{sheetEvent=listener;return()=>{};})}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();});

it("shows only the centered performance controls below monitor values and clears old errors",async()=>{
  vi.mocked(invoke).mockResolvedValue({text:""});
  const state=api.initialState();state.settings.profiles.find(p=>p.id===state.settings.selected_profile)!.transpose={...api.defaultTranspose(),sequence:[4,-3],up:82,down:81};
  vi.spyOn(api,"getState").mockResolvedValue(state);
  state.transpose.current=0;state.transpose.armed=true;
  let fail=true;const command=vi.spyOn(api,"command").mockImplementation(async request=>{
    if(fail)throw new Error("Old setup error");
    if(request.action==="toggle")state.transpose.armed=!state.transpose.armed;
    state.state_sequence++;return api.clone(state);
  });
  await act(async()=>{render(<Overlay kind="monitor"/>);});
  expect([...document.querySelectorAll(".monitor-controls button")].map(b=>b.textContent)).toEqual(["Previous","Pause","Next"]);
  expect(screen.queryByRole("status")).toBeNull();expect(screen.queryByText("Ready")).toBeNull();
  expect(screen.queryByRole("button",{name:"Confirm & Resume"})).toBeNull();expect(screen.queryByLabelText("Current game value")).toBeNull();
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Next"}));});expect(screen.getByRole("alert").textContent).toContain("Old setup error");
  fail=false;await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Previous"}));});
  expect(command).toHaveBeenCalledWith({type:"transpose",action:"previous"});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Pause"}));});
  expect(command).toHaveBeenLastCalledWith({type:"transpose",action:"toggle"});
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Resume"}));});
  expect(screen.getByRole("button",{name:"Pause"})).toBeTruthy();
});

it("keeps a newly sent sheet when the initial get_sheet reply arrives late",async()=>{
  let finish:(value:unknown)=>void=()=>{};
  vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>{render(<Overlay kind="sheet"/>);});
  await act(async()=>{sheetEvent({payload:{text:"New sheet"}});finish({text:"Old sheet"});});
  expect(screen.getByLabelText("Piano sheet").textContent).toBe("New sheet");
  expect(screen.getByLabelText("Piano sheet").textContent).not.toContain("Old sheet");
});

it("colors floating sheets and applies the native stay-on-top control",async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==="get_sheet"?{text:"Transpose by: -2\n[etu] - :1"}:{});
  await act(async()=>{render(<Overlay kind="sheet"/>);});
  expect(screen.getByLabelText("Piano sheet").querySelector(".sheet-extended")?.textContent).toBe(":1");
  expect((screen.getByLabelText("Stay on top") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByLabelText("Stay on top"));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("overlay_options",{kind:"sheet",top:false}));
  fireEvent.click(screen.getByLabelText("Colors"));
  expect(screen.getByLabelText("Piano sheet").querySelector(".sheet-chord")).toBeNull();
  expect(screen.queryByLabelText("Click through")).toBeNull();
  expect((screen.getByLabelText("Transpose mode") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.queryByText("Tempo colors")).toBeNull();
  expect(screen.queryByRole("button",{name:"Copy transposes"})).toBeNull();
  const send=vi.spyOn(api,"sendTransposeSequence").mockResolvedValue(api.initialState());
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Send to Transposer"}));});
  expect(send).toHaveBeenCalledWith([-2]);
});

it("disables monitor resume until Up and Down are configured",async()=>{
  vi.mocked(invoke).mockResolvedValue({text:""});vi.spyOn(api,"getState").mockResolvedValue(api.initialState());
  await act(async()=>{render(<Overlay kind="monitor"/>);});
  expect((screen.getByRole("button",{name:"Resume"}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button",{name:"Resume"}).getAttribute("title")).toBe("Assign Up/Down in Transposer.");
});

it("allows automatic zero-baseline recovery from the monitor without manual sync",async()=>{
  vi.mocked(invoke).mockResolvedValue({text:""});
  const state=api.initialState();state.transpose.current=null;
  state.settings.profiles.find(p=>p.id===state.settings.selected_profile)!.transpose={...api.defaultTranspose(),up:82,down:81};
  vi.spyOn(api,"getState").mockResolvedValue(state);
  const command=vi.spyOn(api,"command").mockResolvedValue(state);
  await act(async()=>{render(<Overlay kind="monitor"/>);});
  const resume=screen.getByRole("button",{name:"Resume"}) as HTMLButtonElement;
  expect(resume.disabled).toBe(false);
  await act(async()=>{fireEvent.click(resume);});
  expect(command).toHaveBeenCalledWith({type:"transpose",action:"toggle"});
});

it("regenerates floating modes and commits inline game values with opposite pitch signs",async()=>{
  let sheet:SheetContent={text:"Transpose by: 3\n[etu]\nr",revision:1,source:{midi_filename:"test.mid",settings:{transpose_mode:"auto",manual_transpose_points:[{chord:0,value:-3}]},line_chord_map:[0,0,2]}};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="get_sheet")return sheet;
    if(command==="generate_sheet"){const a=args as {settings:Record<string,unknown>};sheet={...sheet,revision:(sheet.revision??0)+1,source:{...sheet.source!,settings:a.settings}};return sheet;}
    return {};
  });
  await act(async()=>{render(<Overlay kind="sheet"/>);});
  await act(async()=>{fireEvent.change(screen.getByLabelText("Transpose mode"),{target:{value:"manual"}});});
  expect(invoke).toHaveBeenCalledWith("generate_sheet",expect.objectContaining({midiFilename:"test.mid",expectedRevision:1,settings:expect.objectContaining({transpose_mode:"manual"})}));
  const field=screen.getByLabelText("Game transpose at chord 0");
  fireEvent.change(field,{target:{value:"-5"}});
  await act(async()=>{fireEvent.blur(field);});
  expect(invoke).toHaveBeenLastCalledWith("generate_sheet",expect.objectContaining({settings:expect.objectContaining({manual_transpose_points:[{chord:0,value:5}]})}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Add transpose at chord 2"}));});
  expect(invoke).toHaveBeenLastCalledWith("generate_sheet",expect.objectContaining({settings:expect.objectContaining({manual_transpose_points:[{chord:0,value:5},{chord:2,value:5}]})}));
});
it("keeps the last valid floating sheet and mode on failed regeneration",async()=>{
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==="get_sheet")return {text:"Valid sheet",revision:1,source:{midi_filename:"test.mid",settings:{transpose_mode:"auto"},line_chord_map:[0]}};
    if(command==="generate_sheet")throw new Error("MIDI missing");
    return {};
  });
  await act(async()=>{render(<Overlay kind="sheet"/>);});
  await act(async()=>{fireEvent.change(screen.getByLabelText("Transpose mode"),{target:{value:"multi"}});});
  expect(screen.getByLabelText("Piano sheet").textContent).toBe("Valid sheet");
  expect((screen.getByLabelText("Transpose mode") as HTMLSelectElement).value).toBe("auto");
  expect(screen.getByRole("alert").textContent).toContain("MIDI missing");
});
it("removes an explicit manual transpose and lets opacity reach both endpoints",async()=>{
  let sheet:SheetContent={text:"Transpose by: 0\na\nTranspose by: -3\nb",revision:1,source:{midi_filename:"test.mid",settings:{transpose_mode:"manual",manual_transpose_points:[{chord:2,value:3}]},line_chord_map:[0,0,2,2]}};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="get_sheet")return sheet;
    if(command==="generate_sheet"){const a=args as {settings:Record<string,unknown>};sheet={...sheet,text:"Transpose by: 0\na\nb",revision:2,source:{...sheet.source!,settings:a.settings},};return sheet;}
    return {};
  });
  await act(async()=>{render(<Overlay kind="sheet"/>);});
  const remove=screen.getByRole("button",{name:"Remove transpose at chord 2"});
  expect(remove.className).toBe("sheet-point-action");
  await act(async()=>{fireEvent.click(remove);});
  expect(invoke).toHaveBeenLastCalledWith("generate_sheet",expect.objectContaining({settings:expect.objectContaining({manual_transpose_points:[]})}));
  expect(screen.queryByRole("button",{name:"Remove transpose at chord 2"})).toBeNull();
  const opacity=screen.getByLabelText("Sheet opacity") as HTMLInputElement;
  fireEvent.change(opacity,{target:{value:"0.2"}});expect(opacity.closest(".overlay")?.getAttribute("style")).toContain("opacity: 0.2");
  fireEvent.change(opacity,{target:{value:"1"}});expect(opacity.closest(".overlay")?.getAttribute("style")).toContain("opacity: 1");
});
