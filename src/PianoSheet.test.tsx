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
  class Fraction {
    constructor(public numerator:number,public denominator:number){}
    get RealValue(){return this.numerator/this.denominator;}
  }
  return {Fraction,OutlineAndFillStyleEnum:{PlaybackCursor:3},OpenSheetMusicDisplay:class {
    ready=false;Zoom=1;
    cursor={show:vi.fn(),cursorElement:document.createElement("img")};
    GraphicSheet={calculateCursorLineAtTimestamp:vi.fn((timestamp:Fraction)=>{
      const beat=timestamp.RealValue*4,system=Math.floor(beat/4),x=10+(beat%4)*10,y=5+system*20;
      return {Start:{x,y},End:{x,y:y+12}};
    })};
    render=vi.fn();clear=vi.fn();
    constructor(element:HTMLElement){instances.push(this);this.render.mockImplementation(()=>{
      this.cursor.cursorElement.width=30*this.Zoom;
      element.replaceChildren(document.createElementNS("http://www.w3.org/2000/svg","svg"),this.cursor.cursorElement);
    });}
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
  const scoreBeat=()=>osmd.GraphicSheet.calculateCursorLineAtTimestamp.mock.lastCall[0].RealValue*4;
  seek(1.4);expect(scoreBeat()).toBeCloseTo(1.9);
  seek(1.5);expect(scoreBeat()).toBeCloseTo(2);
  seek(0.2);expect(scoreBeat()).toBeCloseTo(.4);
  seek(1.5,6);seek(1.5,7,"https://foreign.example");seek(1.5,7,location.origin,window);
  expect(scoreBeat()).toBeCloseTo(.4);
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

it("moves the marker between note onsets, changes lines immediately, and retains its position after zoom",async()=>{
  const props={content:content(),revision:1,zoom:1,busy:false,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props}/>);await act(async()=>{});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement;
  const osmd=instances[0],marker=osmd.cursor.cursorElement;
  const seek=(time:number)=>fireEvent(window,new MessageEvent("message",{origin:location.origin,source:frame.contentWindow,data:{type:"converter-playback",revision:1,time}}));
  seek(.1);const first=marker.style.transform;
  seek(.15);expect(marker.style.transform).not.toBe(first);
  seek(3.5);expect(marker.style.transform).toBe("translate3d(85px, 250px, 0)");
  view.rerender(<PianoSheet {...props} zoom={2}/>);
  expect(marker.style.transform).toBe("translate3d(170px, 500px, 0)");
  expect(marker.height).toBe(240);
  seek(.1);expect(marker.style.transform).toBe("translate3d(210px, 100px, 0)");
});

it("follows original performance times when the written beat grid is estimated",async()=>{
  const score={...content(),timing:[{beat:0,time:4},{beat:1,time:4.6},{beat:2,time:5.3}]};
  await act(async()=>{render(<PianoSheet content={score} revision={1} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement;
  const seek=(time:number)=>fireEvent(window,new MessageEvent("message",{origin:location.origin,source:frame.contentWindow,data:{type:"converter-playback",revision:1,time}}));
  const scoreBeat=()=>instances[0].GraphicSheet.calculateCursorLineAtTimestamp.mock.lastCall[0].RealValue*4;
  seek(4.3);expect(scoreBeat()).toBeCloseTo(.5);
  seek(4.6);expect(scoreBeat()).toBeCloseTo(1);
  seek(4.95);expect(scoreBeat()).toBeCloseTo(1.5);
  seek(5.3);expect(scoreBeat()).toBeCloseTo(2);
  seek(0);expect(scoreBeat()).toBe(0);
});

it("uses the replacement score's clock without retaining the previous song's timing",async()=>{
  const props={content:content(),revision:1,zoom:1,busy:false,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props}/>);await act(async()=>{});
  const replacement={...content(),timing:[{beat:0,time:4},{beat:1,time:5}]};
  view.rerender(<PianoSheet {...props} content={replacement} revision={2}/>);await act(async()=>{});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement;
  fireEvent(window,new MessageEvent("message",{origin:location.origin,source:frame.contentWindow,data:{type:"converter-playback",revision:2,time:4.5}}));
  expect(instances.at(-1).GraphicSheet.calculateCursorLineAtTimestamp.mock.lastCall[0].RealValue*4).toBeCloseTo(.5);
});

it("pauses playback during regeneration and before the viewer unmounts",async()=>{
  const props={content:content(),revision:1,zoom:1,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props} busy={false}/>);
  await act(async()=>{});
  const player=(screen.getByTitle("Piano playback") as HTMLIFrameElement).contentWindow!;
  const post=vi.spyOn(player,"postMessage");
  const stop=vi.fn();Object.assign(player,{setVisualizerActive:stop});
  view.rerender(<PianoSheet {...props} busy/>);
  expect(post).toHaveBeenLastCalledWith({type:"converter-visibility",visible:false},location.origin);
  view.unmount();
  expect(stop).toHaveBeenCalledWith(false);
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
