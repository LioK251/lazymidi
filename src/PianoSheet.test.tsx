import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {Midi} from "@tonejs/midi";
import {emit} from "@tauri-apps/api/event";
import PianoSheet,{scorePosition} from "./PianoSheet";
import type {PianoContent} from "./converter-api";

const {instances}=vi.hoisted(()=>({instances:[] as any[]}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(async()=>({})),convertFileSrc:()=>"http://converter.localhost/",isTauri:()=>false}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async()=>()=>{}),emit:vi.fn(async()=>{})}));
vi.mock("opensheetmusicdisplay",()=>{
  class Iterator {
    constructor(public index=0){}
    get EndReached(){return this.index>=3;}
    get CurrentSourceTimestamp(){return {RealValue:this.index/4};}
    clone(){return new Iterator(this.index);}
    moveToNext(){this.index++;}
  }
  return {OpenSheetMusicDisplay:class {
    ready=false;
    cursor={iterator:new Iterator(),get Iterator(){return this.iterator;},show:vi.fn(),update:vi.fn(),cursorElement:document.createElement("img")};
    render=vi.fn();clear=vi.fn();
    constructor(element:HTMLElement){instances.push(this);this.render.mockImplementation(()=>element.replaceChildren(document.createElementNS("http://www.w3.org/2000/svg","svg")));}
    async load(){this.ready=true;}
    IsReadyToRender(){return this.ready;}
  }};
});
beforeEach(()=>{
  instances.length=0;
  vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});

function content():PianoContent {
  const midi=new Midi();
  midi.header.tempos=[{ticks:0,bpm:120},{ticks:480,bpm:60}];midi.header.update();
  midi.addTrack().addNote({midi:60,ticks:0,durationTicks:1440});
  return {midi_filename:"Test.mid",musicxml:"<score-partwise/>",midi_base64:btoa(String.fromCharCode(...midi.toArray())),
    tracks:[{id:"1:0",name:"Piano",piano:true},{id:"2:1",name:"Strings",piano:false}],track_ids:["1:0"],split:60,rhythm:"normal",qwerty_settings:{}};
}
const callbacks=()=>({onOpen:vi.fn(),onZoom:vi.fn(),onGenerate:vi.fn(),onError:vi.fn()});

it("uses MIDI tempo changes for the cursor and handles backward seeks without redrawing the score",async()=>{
  await act(async()=>{render(<PianoSheet content={content()} revision={7} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement,osmd=instances[0];
  expect(emit).toHaveBeenCalledWith("piano-sheet-ready",{revision:7,loaded:true});
  const renders=osmd.render.mock.calls.length;
  function seek(time:number,revision=7,origin=location.origin,source:Window=frame.contentWindow!){
    fireEvent(window,new MessageEvent("message",{origin,source,data:{type:"converter-playback",revision,time}}));
  }
  seek(1.4);expect(osmd.cursor.iterator.index).toBe(1);
  seek(1.5);expect(osmd.cursor.iterator.index).toBe(2);
  seek(0.2);expect(osmd.cursor.iterator.index).toBe(0);
  seek(1.5,6);seek(1.5,7,"https://foreign.example");seek(1.5,7,location.origin,window);
  expect(osmd.cursor.iterator.index).toBe(0);
  expect(osmd.render).toHaveBeenCalledTimes(renders);
  expect(scorePosition([0,.5,1.5],9)).toBe(2);
});

it("allows manual reading and explicitly restoring Follow",async()=>{
  await act(async()=>{render(<PianoSheet content={content()} revision={1} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  const follow=screen.getByLabelText("Follow") as HTMLInputElement;
  expect(follow.checked).toBe(true);
  fireEvent.wheel(screen.getByLabelText("Piano notation"));expect(follow.checked).toBe(false);
  fireEvent.click(follow);expect(follow.checked).toBe(true);
});

it("pauses playback during regeneration and before the viewer unmounts",async()=>{
  const props={content:content(),revision:1,zoom:1,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props} busy={false}/>);
  await act(async()=>{});
  const player=(screen.getByTitle("Piano playback") as HTMLIFrameElement).contentWindow!;
  const post=vi.spyOn(player,"postMessage");
  view.rerender(<PianoSheet {...props} busy/>);
  expect(post).toHaveBeenLastCalledWith({type:"converter-visibility",visible:false},location.origin);
  view.unmount();
  expect(post).toHaveBeenLastCalledWith({type:"converter-visibility",visible:false},location.origin);
});

it("validates track and staff choices before regenerating",async()=>{
  const cb=callbacks();
  await act(async()=>{render(<PianoSheet content={content()} revision={1} zoom={1} busy={false} viewOptions={null} {...cb}/>);});
  fireEvent.click(screen.getByText("Tracks & rhythm"));
  const apply=screen.getByRole("button",{name:"Apply to score"}) as HTMLButtonElement;
  fireEvent.click(screen.getByLabelText("Piano"));expect(apply.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Strings"));
  fireEvent.change(screen.getByLabelText("Staff split"),{target:{value:""}});expect(apply.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Staff split"),{target:{value:"55"}});
  fireEvent.change(screen.getByLabelText("Rhythm"),{target:{value:"fine"}});
  fireEvent.click(apply);expect(cb.onGenerate).toHaveBeenCalledWith({track_ids:["2:1"],split:55,rhythm:"fine"});
});
