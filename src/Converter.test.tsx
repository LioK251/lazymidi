import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {invoke} from "@tauri-apps/api/core";
import {WebviewWindow} from "@tauri-apps/api/webviewWindow";
import Converter from "./Converter";
import {thumbnailSrc} from "./ConverterPreviews";

vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(),convertFileSrc:(p:string)=>`http://converter.localhost/${p}`,isTauri:()=>true}));
vi.mock("./backend",async()=>({...await vi.importActual<typeof import("./backend")>("./backend"),whilePaused:async(action:()=>Promise<unknown>)=>action(),ask:async()=>true}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async()=>()=>{})}));
vi.mock("@tauri-apps/api/webviewWindow",()=>({WebviewWindow:{getByLabel:vi.fn()}}));
const file={filename:"test.mid",video_title:"Test piano",time_str:"Today",file_size:100,source_type:"midi"};
beforeEach(()=>{
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(null);
  let revision=0;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="converter_status")return {status:{installed:"cpu",running:true,installing:false,received:0,total:0,error:null},packs:[]} as never;
    if(command==="generate_sheet"){const a=args as {midiFilename:string;settings:Record<string,unknown>};return {text:"[etu]",sheets_filename:"test_sheets.txt",revision:++revision,source:{midi_filename:a.midiFilename,settings:a.settings,line_chord_map:[0]}};}
    const path=(args as {path?:string})?.path;
    if(path==="/api/midi-files")return {midi_files:[file]} as never;
    if(path?.startsWith("/api/history"))return [] as never;
    if(path==="/api/settings")return {} as never;
    if(path==="/api/convert-to-sheets")return {sheet_text:"[etu]",sheets_filename:"test_sheets.txt",line_chord_map:[0]} as never;
    return {status:"ok"} as never;
  });
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("saves the compute preference immediately, restores it, and keeps draft formatting unsaved",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  let saved:Record<string,unknown>={quantize:35};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="converter_status")return {status:{installed:"cuda",running:true},packs:[]};
    const a=args as {path?:string;body?:Record<string,unknown>};
    if(a?.path==="/api/settings"){if(a.body)saved=a.body;return saved;}
    return original(command,args);
  });
  const first=render(<Converter active onError={vi.fn()}/>);await screen.findByText("Ready");
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  fireEvent.change(screen.getByLabelText("Chord grouping (ms)"),{target:{value:"80"}});
  fireEvent.click(screen.getByRole("button",{name:"Convert"}));
  await act(async()=>{fireEvent.change(screen.getByLabelText("Compute device"),{target:{value:"cuda"}});});
  expect(saved).toEqual({quantize:35,compute_device:"cuda"});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Choose audio or video"}));});
  expect(invoke).toHaveBeenCalledWith("converter_pick",{kind:"media",device:"cuda"});
  first.unmount();await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  expect((screen.getByLabelText("Compute device") as HTMLSelectElement).value).toBe("cuda");
  await act(async()=>{fireEvent.change(screen.getByLabelText("Compute device"),{target:{value:"cpu"}});});
  expect(saved.compute_device).toBe("cpu");
});
it("uses CPU when a saved CUDA preference is unavailable without overwriting it",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>(args as {path?:string})?.path==="/api/settings"?{compute_device:"cuda"}:original(command,args));
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  expect((screen.getByLabelText("Compute device") as HTMLSelectElement).value).toBe("cpu");
  expect(vi.mocked(invoke).mock.calls.some(([,a])=>(a as {path?:string;body?:unknown})?.path==="/api/settings"&&(a as {body?:unknown}).body)).toBe(false);
});
it("keeps the previous compute device when saving fails",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="converter_status")return {status:{installed:"cuda",running:true},packs:[]};
    const a=args as {path?:string;body?:unknown};if(a?.path==="/api/settings"&&a.body)throw new Error("Save failed");
    return original(command,args);
  });
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  await act(async()=>{fireEvent.change(screen.getByLabelText("Compute device"),{target:{value:"cuda"}});});
  expect(error).toHaveBeenCalledWith("Save failed");
  expect((screen.getByLabelText("Compute device") as HTMLSelectElement).value).toBe("cpu");
});
it("places Cancel beside Convert link and keeps file cancellation available",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>(args as {path?:string})?.path==="/api/convert"?{task_id:"link-job"}:original(command,args));
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Media link"}));
  fireEvent.change(screen.getByLabelText("Media link"),{target:{value:"https://youtube.com/watch?v=test"}});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Convert link"}));});
  const cancel=screen.getByRole("button",{name:"Cancel"});
  expect(cancel.parentElement).toBe(screen.getByRole("button",{name:"Convert link"}).parentElement);
  await act(async()=>{fireEvent.click(cancel);});
  expect(invoke).toHaveBeenCalledWith("converter_request",expect.objectContaining({path:"/api/stop/link-job"}));
  fireEvent.click(screen.getByRole("button",{name:"Local file"}));
  expect(screen.getByRole("button",{name:"Cancel"})).toBeTruthy();
});
it("refreshes browser conversions when returning to the app without changing selection",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;let external=false;
  vi.mocked(invoke).mockImplementation(async(command,args)=>(args as {path?:string})?.path==="/api/midi-files"&&external?{midi_files:[file,{...file,filename:"browser.mid",video_title:"Browser song"}]}:original(command,args));
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Library"}));external=true;
  await act(async()=>{fireEvent.focus(window);});
  expect(screen.getByRole("article",{name:"Browser song"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"Library"}).getAttribute("aria-pressed")).toBe("true");
});
it("reuses an existing environment with validation progress and CUDA capability",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  let phase="empty";
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="converter_use_environment"){phase="checking";return;}
    if(command==="converter_status")return {status:{installed:phase==="ready"?"cuda":null,validating:phase==="checking",installing:false,environment:phase==="ready"?{python:"C:/old/.cuda-venv/Scripts/python.exe",python_version:"3.10.19",torch_version:"2.9.1+cu128",cuda_available:true}:null},packs:[]};
    return original(command,args);
  });
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Use existing converter environment"}));});
  await waitFor(()=>expect(screen.getByText(/Checking Python, Transkun model/)).toBeTruthy(),{timeout:3000});
  expect((screen.getByRole("button",{name:"Use existing converter environment"}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button",{name:"Choose audio or video"}) as HTMLButtonElement).disabled).toBe(true);
  phase="ready";
  await waitFor(()=>expect(screen.getByText("Using existing Python 3.10.19 · NVIDIA CUDA ready")).toBeTruthy(),{timeout:3000});
  await waitFor(()=>expect((screen.getByRole("button",{name:"Choose audio or video"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("Processing options"));
  expect((screen.getByRole("option",{name:"NVIDIA CUDA"}) as HTMLOptionElement).disabled).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("converter_install",expect.anything());
  expect(invoke).not.toHaveBeenCalledWith("app_command",expect.anything());
});
it("shows failed environment validation while retaining the existing runtime",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>command==="converter_status"?{status:{installed:"cpu",installing:false,validating:false,error:"Cannot load transkun: missing dependency"},packs:[]}:original(command,args));
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  expect(await screen.findByText("Cannot load transkun: missing dependency")).toBeTruthy();
  expect((screen.getByRole("button",{name:"Choose audio or video"}) as HTMLButtonElement).disabled).toBe(false);
});
it("opens the reusable visualizer from the preview without a duplicate Visualizer button",async()=>{
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  expect(within(screen.getByRole("navigation",{name:"Converter sections"})).queryByRole("button",{name:"Visualizer"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Library"}));
  const card=await screen.findByRole("article",{name:"Test piano"});
  await act(async()=>{fireEvent.click(within(card).getByRole("button",{name:"Preview Test piano"}));});
  expect(within(card).queryByRole("button",{name:"Visualizer"})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==="open_visualizer")).toEqual([["open_visualizer",{midiFilename:"test.mid"}]]);
  expect(screen.queryByTitle("Piano visualizer")).toBeNull();
});
it.each(["recent","library"])("automatically generates from the %s Sheet action",async(location)=>{
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  if(location==="library")fireEvent.click(screen.getByRole("button",{name:"Library"}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Sheet"}));});
  expect(await screen.findByText("[etu]")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("generate_sheet",expect.objectContaining({midiFilename:"test.mid",expectedRevision:null}));
  expect(invoke).not.toHaveBeenCalledWith("app_command",expect.anything());expect(error).not.toHaveBeenCalled();
});
it.each(["recent","library"])("keeps the %s section selected when the floating sheet is visible",async(location)=>{
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue({isVisible:async()=>true} as WebviewWindow);
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  const section=location==="library"?"Library":"Convert";
  fireEvent.click(screen.getByRole("button",{name:section}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Sheet"}));});
  expect(screen.getByRole("button",{name:section}).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button",{name:"Sheets"}).getAttribute("aria-pressed")).toBe("false");
  expect(invoke).toHaveBeenCalledWith("generate_sheet",expect.objectContaining({midiFilename:"test.mid"}));
  expect(error).not.toHaveBeenCalled();
});
it("opens Sheets when the floating viewer exists but is hidden",async()=>{
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue({isVisible:async()=>false,isMinimized:async()=>false} as WebviewWindow);
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Sheet"}));});
  expect(screen.getByRole("button",{name:"Sheets"}).getAttribute("aria-pressed")).toBe("true");
  expect(await screen.findByText("[etu]")).toBeTruthy();
});
it.each([true,false])("restores a minimized sheet before generating without redirecting (visible: %s)",async(visible)=>{
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue({isVisible:async()=>visible,isMinimized:async()=>true} as WebviewWindow);
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Sheet"}));});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>["open_overlay","generate_sheet"].includes(command)).map(([command])=>command)).toEqual(["open_overlay","generate_sheet"]);
  expect(screen.getByRole("button",{name:"Convert"}).getAttribute("aria-pressed")).toBe("true");
  expect(error).not.toHaveBeenCalled();
});
it("saves Always open Float immediately without saving draft formatting, and restores it on reopening",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  let saved:Record<string,unknown>={quantize:35,visualizer_style:"neon"};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    const a=args as {path?:string;body?:Record<string,unknown>};
    if(a?.path==="/api/settings"){if(a.body)saved=a.body;return saved;}
    return original(command,args);
  });
  const view=render(<Converter active onError={vi.fn()}/>);
  await screen.findByText("Ready");
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  expect((screen.getByLabelText("Always open Float") as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText("Chord grouping (ms)"),{target:{value:"80"}});
  await act(async()=>{fireEvent.click(screen.getByLabelText("Always open Float"));});
  expect(saved).toEqual({quantize:35,visualizer_style:"neon",always_open_float:true});
  expect((screen.getByLabelText("Chord grouping (ms)") as HTMLInputElement).value).toBe("80");
  view.unmount();
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  expect((screen.getByLabelText("Always open Float") as HTMLInputElement).checked).toBe(true);
  await act(async()=>{fireEvent.click(screen.getByLabelText("Always open Float"));});
  expect(saved.always_open_float).toBe(false);
});
it.each(["recent","library"])("opens Float before generating from %s without redirecting when the preference is on",async(location)=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if((args as {path?:string})?.path==="/api/settings")return {always_open_float:true};
    const value=await original(command,args);
    if(command==="generate_sheet")(value as {source:{settings:Record<string,unknown>}}).source.settings={always_open_float:false};
    return value;
  });
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  const section=location==="library"?"Library":"Convert";
  fireEvent.click(screen.getByRole("button",{name:section}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Sheet"}));});
  expect(invoke).toHaveBeenCalledWith("open_overlay",{kind:"sheet"});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>["open_overlay","generate_sheet"].includes(command)).map(([command])=>command)).toEqual(["open_overlay","generate_sheet"]);
  expect(screen.getByRole("button",{name:section}).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button",{name:"Sheets"}).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  expect((screen.getByLabelText("Always open Float") as HTMLInputElement).checked).toBe(true);
  expect(error).not.toHaveBeenCalled();
});
it("retains the previous preference when saving fails",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    const a=args as {path?:string;body?:unknown};
    if(a?.path==="/api/settings"&&a.body)throw new Error("Save failed");
    return original(command,args);
  });
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  await act(async()=>{fireEvent.click(screen.getByLabelText("Always open Float"));});
  expect(error).toHaveBeenCalledWith("Save failed");
  expect((screen.getByLabelText("Always open Float") as HTMLInputElement).checked).toBe(false);
});
it("does not redirect or generate if opening Float fails",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="open_overlay")throw new Error("Window unavailable");
    if((args as {path?:string})?.path==="/api/settings")return {always_open_float:true};
    return original(command,args);
  });
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Sheet"}));});
  expect(error).toHaveBeenCalledWith("Window unavailable");
  expect(invoke).not.toHaveBeenCalledWith("generate_sheet",expect.anything());
  expect(screen.getByRole("button",{name:"Convert"}).getAttribute("aria-pressed")).toBe("true");
});
it.each([false,true])("generates the completed conversion's MIDI from Make sheet (always Float: %s)",async(alwaysFloat)=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="converter_pick")return {task_id:"job-test"};
    if((args as {path?:string})?.path==="/api/settings")return {always_open_float:alwaysFloat};
    if((args as {path?:string})?.path==="/api/status/job-test")return {status:"completed",midi_name:"test.mid"};
    return original(command,args);
  });
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Choose audio or video"}));});
  await screen.findByRole("button",{name:"Make sheet"});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Make sheet"}));});
  if(alwaysFloat){
    expect(invoke).toHaveBeenCalledWith("open_overlay",{kind:"sheet"});
    expect(screen.getByRole("button",{name:"Convert"}).getAttribute("aria-pressed")).toBe("true");
  }else expect(await screen.findByText("[etu]")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("generate_sheet",expect.objectContaining({midiFilename:"test.mid"}));
});
it("rejects malformed manual points before submitting a conversion",async()=>{
  const error=vi.fn();await act(async()=>{render(<Converter active onError={error}/>);});
  await screen.findByRole("button",{name:"Choose audio or video"});
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  fireEvent.change(screen.getByLabelText("MIDI"),{target:{value:"test.mid"}});
  fireEvent.click(screen.getByRole("button",{name:"Manual"}));
  fireEvent.change(screen.getByLabelText("Manual points (chord / value JSON)"),{target:{value:'[{"chord":0,"value":51}]'}});
  fireEvent.click(screen.getByRole("button",{name:"Generate"}));
  await waitFor(()=>expect(error).toHaveBeenCalledWith(expect.stringContaining("−50 to 50")));
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==="generate_sheet")).toBe(false);
});
it("switches transpose modes and independently refreshes BPM and timing markers",async()=>{
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  fireEvent.change(screen.getByLabelText("MIDI"),{target:{value:"test.mid"}});
  const requests=()=>vi.mocked(invoke).mock.calls.filter(([command])=>command==="generate_sheet");
  for(const [label,mode] of [["Auto","auto"],["Multi","multi"],["Manual","manual"],["Original","none"]]){
    await act(async()=>{fireEvent.click(screen.getByRole("button",{name:label}));});
    if(!requests().length)await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Generate"}));});
    expect(requests().at(-1)?.[1]).toMatchObject({settings:{transpose_mode:mode}});
    expect(screen.getByRole("button",{name:label}).getAttribute("aria-pressed")).toBe("true");
  }
  await act(async()=>{fireEvent.click(screen.getByLabelText("Show BPM & tempo changes"));});
  expect(requests().at(-1)?.[1]).toMatchObject({settings:{show_bpm_changes_as_comments:false,show_tempo_timing_marks:true}});
  await act(async()=>{fireEvent.click(screen.getByLabelText("Show timing markers"));});
  expect(requests().at(-1)?.[1]).toMatchObject({settings:{show_bpm_changes_as_comments:false,show_tempo_timing_marks:false}});
  fireEvent.change(screen.getByLabelText("Line breaks"),{target:{value:"automatically"}});
  expect((screen.getByLabelText("Beats per line") as HTMLInputElement).disabled).toBe(true);
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Save settings"}));});
  expect(invoke).toHaveBeenCalledWith("converter_request",expect.objectContaining({path:"/api/settings",body:expect.objectContaining({transpose_mode:"none",show_bpm_changes_as_comments:false,show_tempo_timing_marks:false,break_lines_how:"automatically"})}));
  expect(invoke).not.toHaveBeenCalledWith("app_command",expect.anything());
});
it("edits game transpose values while preserving saved pitch-shift signs",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if((args as {path?:string;body?:unknown})?.path==="/api/settings"&&!(args as {body?:unknown})?.body)return {transpose_mode:"manual",manual_transpose_points:[{chord:0,value:-3},{chord:8,value:2}]};
    return original(command,args);
  });
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  fireEvent.change(screen.getByLabelText("MIDI"),{target:{value:"test.mid"}});
  expect((screen.getByLabelText("Game transpose at chord 0") as HTMLInputElement).value).toBe("3");
  expect((screen.getByLabelText("Game transpose at chord 8") as HTMLInputElement).value).toBe("-2");
  fireEvent.change(screen.getByLabelText("Game transpose at chord 8"),{target:{value:"-5"}});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Generate"}));});
  const raw=[{chord:0,value:-3},{chord:8,value:5}];
  expect(invoke).toHaveBeenCalledWith("generate_sheet",expect.objectContaining({settings:expect.objectContaining({manual_transpose_points:raw})}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Save settings"}));});
  expect(invoke).toHaveBeenCalledWith("converter_request",expect.objectContaining({path:"/api/settings",body:expect.objectContaining({manual_transpose_points:raw})}));
  expect((screen.getByLabelText("Game transpose at chord 0") as HTMLInputElement).value).toBe("3");
});
it.each([[{auto_transpose:false,multi_transpose:true},"Original"],[{multi_transpose:true},"Multi"],[{transpose_mode:"manual",auto_transpose:false},"Manual"]])("loads legacy transpose preferences %j",async(saved,label)=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>(args as {path?:string})?.path==="/api/settings"?saved:original(command,args));
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  expect(screen.getByRole("button",{name:label}).getAttribute("aria-pressed")).toBe("true");
});
it("can retry failed startup without remounting and keeps actions disabled until ready",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  let failed=false;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if((args as {path?:string})?.path==="/api/health"&&!failed){failed=true;throw new Error("Runtime unavailable");}
    return original(command,args);
  });
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  expect(await screen.findByText("Could not start the converter.")).toBeTruthy();
  expect((screen.getByRole("button",{name:"Choose audio or video"}) as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Retry startup"}));});
  await waitFor(()=>expect((screen.getByRole("button",{name:"Choose audio or video"}) as HTMLButtonElement).disabled).toBe(false));
});
it("never exports a stale sheet after switching MIDI while generation is pending",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  let finish:(value:unknown)=>void=()=>{};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    const path=(args as {path?:string})?.path;
    if(path==="/api/midi-files")return {midi_files:[file,{...file,filename:"other.mid",video_title:"Other piano"}]} as never;
    if(command==="generate_sheet")return new Promise(resolve=>{finish=resolve;});
    return original(command,args);
  });
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Sheets"}));
  fireEvent.change(screen.getByLabelText("MIDI"),{target:{value:"test.mid"}});
  fireEvent.click(screen.getByRole("button",{name:"Generate"}));
  fireEvent.change(screen.getByLabelText("MIDI"),{target:{value:"other.mid"}});
  await act(async()=>{finish({text:"OLD SHEET",sheets_filename:"old.txt",revision:1,source:{midi_filename:"test.mid",settings:{},line_chord_map:[0]}});});
  expect(screen.queryByText("OLD SHEET")).toBeNull();
  expect((screen.getByRole("button",{name:"Export"}) as HTMLButtonElement).disabled).toBe(true);
 });
it("does not offer a Visualizer tab before setup",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>command==="converter_status"?{status:{installed:null,installing:false},packs:[]}:original(command,args));
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  expect(screen.getByText("1. Set up the converter once")).toBeTruthy();
  expect((screen.getByRole("button",{name:"Choose audio or video"}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button",{name:"Visualizer"})).toBeNull();
});
it("allows only scoped artwork and trusted video thumbnails",()=>{
  expect(thumbnailSrc("/converted/thumb.jpg")).toBe("http://converter.localhost/converted/thumb.jpg");
  expect(thumbnailSrc("https://img.youtube.com/vi/abc/mqdefault.jpg")).toContain("img.youtube.com/vi/abc/");
  for(const value of ["/converted/../../settings.json","file:///private.png","javascript:alert(1)","https://evil.example/thumb.jpg","https://img.youtube.com.evil.example/vi/x/a.jpg"])
    expect(thumbnailSrc(value)).toBeUndefined();
});

it("imports history and converted MIDI from Library and refreshes the cards",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  let imported=false;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="converter_pick"&&(args as {kind:string}).kind==="import"){imported=true;return {copied:3,midis:1,history:1,skipped:0};}
    if((args as {path?:string})?.path==="/api/midi-files"&&imported)return {midi_files:[file,{...file,filename:"old.mid",video_title:"Imported song"}]};
    return original(command,args);
  });
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Library"}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Import history & MIDI folder"}));});
  expect(await screen.findByRole("article",{name:"Imported song"})).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Imported 1 MIDI files and 1 history entries");
  expect(invoke).not.toHaveBeenCalledWith("app_command",expect.anything());
});

it("limits large libraries to 24 previews and searches across all pages",async()=>{
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>(args as {path?:string})?.path==="/api/midi-files"?{midi_files:Array.from({length:26},(_,i)=>({...file,filename:`song-${i}.mid`,video_title:`Song ${i}`}))}:original(command,args));
  await act(async()=>{render(<Converter active onError={vi.fn()}/>);});
  fireEvent.click(screen.getByRole("button",{name:"Library"}));
  expect(screen.getAllByRole("article")).toHaveLength(24);
  fireEvent.click(screen.getByRole("button",{name:"Next page"}));
  expect(screen.getAllByRole("article")).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox",{name:"Search library"}),{target:{value:"Song 1"}});
  expect(screen.getAllByRole("article")).toHaveLength(11);
  expect(screen.queryByRole("button",{name:"Next page"})).toBeNull();
});
