import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {Midi} from "@tonejs/midi";
import {emit} from "@tauri-apps/api/event";
import {invoke} from "@tauri-apps/api/core";
import {printPiano} from "./piano-print";
import PianoSheet from "./PianoSheet";
import {scorePosition} from "./piano-score";
import type {PianoContent} from "./converter-api";

const {instances,fault}=vi.hoisted(()=>({instances:[] as any[],fault:{render:false,sparse:false}}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(async()=>({})),convertFileSrc:()=>"http://converter.localhost/",isTauri:()=>false}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async()=>()=>{}),emit:vi.fn(async()=>{})}));
vi.mock("./piano-print",()=>({printPiano:vi.fn(async()=>{})}));
vi.mock("opensheetmusicdisplay",()=>{
  class Fraction {
    constructor(public numerator:number,public denominator:number){}
    get RealValue(){return this.numerator/this.denominator;}
  }
  const systems=Array.from({length:3},(_,row)=>{
    const y=5+row*20;
    const measure={parentSourceMeasure:{AbsoluteTimestamp:new Fraction(row,1),Duration:new Fraction(1,1)},
      PositionAndShape:{AbsolutePosition:{x:5,y}},beginInstructionsWidth:5,
      staffEntries:Array.from({length:4},(_,beat)=>{
        const group=document.createElementNS("http://www.w3.org/2000/svg","g");
        group.append(document.createElementNS("http://www.w3.org/2000/svg","path"));
        return {getAbsoluteTimestamp:()=>new Fraction(row*4+beat,4),
          graphicalVoiceEntries:[{parentVoiceEntry:{IsGrace:false},notes:[{getSVGGElement:()=>group}],
            vfStaveNote:{getAbsoluteX:()=>94+beat*100,
              isCenterAligned:()=>false,getTickContext:()=>({getX:()=>beat*100})}}]};
      })};
    return {PositionAndShape:{AbsolutePosition:{x:5,y},BorderTop:-9,BorderBottom:15},
      StaffLines:[{PositionAndShape:{AbsolutePosition:{y}}},{PositionAndShape:{AbsolutePosition:{y:y+8}}}],
      GraphicalMeasures:[[measure]],GetRightBorderAbsoluteXPosition:()=>50};
  });
  return {Fraction,PointF2D:class{constructor(public x:number,public y:number){}},GraphicalMeasure:class{},
    VexFlowMeasure:class{finalizeTuplets(){}},OpenSheetMusicDisplay:class {
    ready=false;Zoom=1;
    cursor={show:vi.fn(),cursorElement:document.createElement("img")};
    EngravingRules={PageLeftMargin:5,PageRightMargin:5,SystemLeftMargin:0,SystemRightMargin:0};
    GraphicSheet={MeasureList:[[{minimumStaffEntriesWidth:30,beginInstructionsWidth:10,endInstructionsWidth:1}]],
      MusicPages:[{MusicSystems:systems}],
      domToSvg:vi.fn(point=>point),svgToOsmd:vi.fn(point=>point),
      GetNearestNote:vi.fn(),tryGetTimeStampFromPosition:vi.fn(()=>new Fraction(3,8)),GetNearestObject:vi.fn()};
    render=vi.fn();clear=vi.fn();
    constructor(element:HTMLElement){instances.push(this);
      if(fault.sparse)this.GraphicSheet.MeasureList.push([undefined as any,undefined as any]);
      this.render.mockImplementation(()=>{
      this.cursor.cursorElement=document.createElement("img");
      this.cursor.cursorElement.width=30*this.Zoom;
      const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
      for(const system of systems)for(const entry of system.GraphicalMeasures[0][0].staffEntries){
        svg.append(entry.graphicalVoiceEntries[0].notes[0].getSVGGElement());
      }
      element.replaceChildren(svg,this.cursor.cursorElement);
      if(fault.render)throw new Error('Layout failed');
    });}
    async load(){this.ready=true;}
    IsReadyToRender(){return this.ready;}
  }};
});
beforeEach(()=>{
  instances.length=0;
  fault.render=false;fault.sparse=false;vi.mocked(emit).mockClear();
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
const cursorBeat=(osmd:any)=>(parseFloat(osmd.cursor.cursorElement.style.transform.slice(12))+6)/(100*osmd.Zoom)-1;
const scorePaper=()=>screen.getByLabelText('Piano notation').querySelector('.piano-score-paper')!;

it('renders scores with missing measure slots and keeps silent piano bars expanded',async()=>{
  fault.sparse=true;
  await act(async()=>{render(<PianoSheet content={content()} revision={1} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(instances[0].EngravingRules.AutoGenerateMultipleRestMeasuresFromRestMeasures).toBe(false);
  expect(emit).toHaveBeenCalledWith('piano-sheet-ready',{revision:1,loaded:true});
});

it('reports a failed layout even with partial SVG and clears the error after a successful redraw',async()=>{
  fault.render=true;
  const props={content:content(),revision:1,zoom:1,busy:false,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props}/>);await act(async()=>{});
  expect(scorePaper().querySelector('svg')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Layout failed');
  expect(emit).toHaveBeenCalledWith('piano-sheet-ready',{revision:1,loaded:false});
  expect(emit).not.toHaveBeenCalledWith('piano-sheet-ready',{revision:1,loaded:true});
  fault.render=false;
  view.rerender(<PianoSheet {...props} zoom={1.2}/>);await act(async()=>{});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(emit).toHaveBeenLastCalledWith('piano-sheet-ready',{revision:1,loaded:true});
});

it('exports the displayed revision and prints its score with the clean song title',async()=>{
  const score={...content(),midi_filename:'A & B_transkun.mid'};
  await act(async()=>{render(<PianoSheet content={score} revision={9} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  expect(document.querySelector('.piano-score-title')).toBeNull();
  fireEvent.click(screen.getByText('Export'));
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Export MusicXML'}));});
  expect(invoke).toHaveBeenCalledWith('export_piano_sheet',{expectedRevision:9});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Print / Save PDF'}));});
  expect(printPiano).toHaveBeenCalledWith(score.musicxml,'A & B');
});

it.each([false,true])('waits for playback to become silent before exporting (print=%s)',async print=>{
  await act(async()=>{render(<PianoSheet content={content()} revision={9} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  const player=(screen.getByTitle('Piano playback') as HTMLIFrameElement).contentWindow!;
  let silence:()=>void=()=>{};
  const paused=new Promise<void>(resolve=>{silence=resolve;});
  const pause=vi.fn(()=>paused);
  Object.assign(player,{pausePianoPlayback:pause});
  vi.mocked(invoke).mockClear();vi.mocked(printPiano).mockClear();
  fireEvent.click(screen.getByText('Export'));
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:print?'Print / Save PDF':'Export MusicXML'}));});
  expect(pause).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalledWith('export_piano_sheet',expect.anything());
  expect(printPiano).not.toHaveBeenCalled();
  await act(async()=>{silence();});
  if(print)expect(printPiano).toHaveBeenCalledOnce();
  else expect(invoke).toHaveBeenCalledWith('export_piano_sheet',{expectedRevision:9});
});

it('reports an audio pause failure before exporting and allows a retry',async()=>{
  const cb=callbacks();
  await act(async()=>{render(<PianoSheet content={content()} revision={9} zoom={1} busy={false} viewOptions={null} {...cb}/>);});
  const player=(screen.getByTitle('Piano playback') as HTMLIFrameElement).contentWindow!;
  const pause=vi.fn().mockRejectedValueOnce(new Error('Audio could not pause')).mockResolvedValue(undefined);
  Object.assign(player,{pausePianoPlayback:pause});
  vi.mocked(invoke).mockClear();
  fireEvent.click(screen.getByText('Export'));
  const button=screen.getByRole('button',{name:'Export MusicXML'});
  await act(async()=>{fireEvent.click(button);});
  expect(cb.onError).toHaveBeenCalledWith('Audio could not pause');
  expect(invoke).not.toHaveBeenCalledWith('export_piano_sheet',expect.anything());
  await act(async()=>{fireEvent.click(button);});
  expect(invoke).toHaveBeenCalledWith('export_piano_sheet',{expectedRevision:9});
});

it("uses MIDI tempo changes for the cursor and handles backward seeks without redrawing the score",async()=>{
  await act(async()=>{render(<PianoSheet content={content()} revision={7} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement,osmd=instances[0];
  expect(emit).toHaveBeenCalledWith("piano-sheet-ready",{revision:7,loaded:true});
  const renders=osmd.render.mock.calls.length;
  function seek(time:number,revision=7,origin=location.origin,source:Window=frame.contentWindow!){
    fireEvent(window,new MessageEvent("message",{origin,source,data:{type:"converter-playback",revision,time}}));
  }
  const scoreBeat=()=>cursorBeat(osmd);
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
  fireEvent.keyDown(screen.getByLabelText("Piano notation"),{key:"ArrowRight"});expect(follow.checked).toBe(false);
});

it("keeps the whole playing grand staff visible and leaves manual scrolling alone",async()=>{
  await act(async()=>{render(<PianoSheet content={content()} revision={1} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  const scroller=screen.getByLabelText('Piano notation'),marker=instances[0].cursor.cursorElement;
  const frame=screen.getByTitle('Piano playback') as HTMLIFrameElement;
  let top=480;
  vi.spyOn(scroller,'getBoundingClientRect').mockReturnValue(new DOMRect(0,100,1000,500));
  vi.spyOn(marker,'getBoundingClientRect').mockImplementation(()=>new DOMRect(200,top-scroller.scrollTop,12,240));
  const seek=(time:number)=>fireEvent(window,new MessageEvent('message',{origin:location.origin,source:frame.contentWindow,data:{type:'converter-playback',revision:1,time}}));
  seek(1);
  expect(marker.getBoundingClientRect().top-9*8).toBeCloseTo(124);
  expect(marker.getBoundingClientRect().bottom).toBeLessThanOrEqual(552);
  expect(marker.getBoundingClientRect().top).toBeGreaterThanOrEqual(124);
  const position=scroller.scrollTop;
  seek(1.1);expect(scroller.scrollTop).toBe(position);
  fireEvent.wheel(scroller);top=960;seek(2);expect(scroller.scrollTop).toBe(position);
  fireEvent.click(screen.getByLabelText('Follow'));
  expect(marker.getBoundingClientRect().bottom).toBeLessThanOrEqual(552);
});

it("seeks clicked notation through the performance clock and ignores clicks during regeneration",async()=>{
  const props={content:{...content(),timing:[{beat:0,time:4},{beat:1,time:4.6},{beat:2,time:5.3}]},revision:7,zoom:1,busy:false,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props}/>);await act(async()=>{});
  const frame=screen.getByTitle('Piano playback') as HTMLIFrameElement;
  const post=vi.spyOn(frame.contentWindow!,'postMessage');
  expect(scorePaper().hasAttribute('title')).toBe(false);
  fireEvent.click(scorePaper(),{clientX:321,clientY:210});
  expect(instances[0].GraphicSheet.tryGetTimeStampFromPosition).toHaveBeenCalledWith({x:321,y:210});
  expect(post).toHaveBeenLastCalledWith({type:'converter-seek',revision:7,time:expect.closeTo(4.95)},location.origin);
  instances[0].GraphicSheet.GetNearestNote.mockReturnValue({sourceNote:{getAbsoluteTimestamp:()=>({RealValue:.25})}});
  fireEvent.click(scorePaper(),{clientX:321,clientY:250});
  expect(post).toHaveBeenLastCalledWith({type:'converter-seek',revision:7,time:4.6},location.origin);
  // Compact scores can put the preceding rest inside the engraver's nearest-note bounds.
  fireEvent.click(scorePaper().querySelector('path')!,{clientX:321,clientY:250});
  expect(post).toHaveBeenLastCalledWith({type:'converter-seek',revision:7,time:4},location.origin);
  view.rerender(<PianoSheet {...props} busy/>);post.mockClear();
  fireEvent.click(scorePaper());
  expect(post).not.toHaveBeenCalled();
});

it("moves the marker between note onsets, changes lines immediately, and retains its position after zoom",async()=>{
  const props={content:content(),revision:1,zoom:1,busy:false,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props}/>);await act(async()=>{});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement;
  const osmd=instances[0];let marker=osmd.cursor.cursorElement;
  const seek=(time:number)=>fireEvent(window,new MessageEvent("message",{origin:location.origin,source:frame.contentWindow,data:{type:"converter-playback",revision:1,time}}));
  seek(.1);const first=marker.style.transform;
  seek(.15);expect(marker.style.transform).not.toBe(first);
  seek(3.5);expect(marker.style.transform).toBe("translate3d(74px, 200px, 0)");
  view.rerender(<PianoSheet {...props} zoom={2}/>);
  marker=osmd.cursor.cursorElement;
  expect(marker.style.transform).toBe("translate3d(154px, 400px, 0)");
  expect(marker.classList.contains('piano-score-cursor')).toBe(true);
  expect(marker.width).toBe(12);
  expect(marker.height).toBe(192);
  seek(.1);expect(marker.style.transform).toBe("translate3d(186px, 80px, 0)");
});

it("preserves the engraver's minimum measure width when the score is zoomed in",async()=>{
  await act(async()=>{render(<PianoSheet content={content()} revision={1} zoom={2} busy={false} viewOptions={null} {...callbacks()}/>);});
  expect((document.querySelector('.piano-score-paper') as HTMLElement).style.minWidth).toBe('816px');
});

it("follows original performance times when the written beat grid is estimated",async()=>{
  const score={...content(),timing:[{beat:0,time:4},{beat:1,time:4.6},{beat:2,time:5.3}]};
  await act(async()=>{render(<PianoSheet content={score} revision={1} zoom={1} busy={false} viewOptions={null} {...callbacks()}/>);});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement;
  const seek=(time:number)=>fireEvent(window,new MessageEvent("message",{origin:location.origin,source:frame.contentWindow,data:{type:"converter-playback",revision:1,time}}));
  const scoreBeat=()=>cursorBeat(instances[0]);
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
  expect(cursorBeat(instances.at(-1))).toBeCloseTo(.5);
});

it("pauses playback during regeneration and before the viewer unmounts",async()=>{
  const props={content:content(),revision:1,zoom:1,viewOptions:null,...callbacks()};
  const view=render(<PianoSheet {...props} busy={false}/>);
  await act(async()=>{});
  const frame=screen.getByTitle("Piano playback") as HTMLIFrameElement,player=frame.contentWindow!;
  const post=vi.spyOn(player,"postMessage");
  const stop=vi.fn();Object.assign(player,{setVisualizerActive:stop});
  view.rerender(<PianoSheet {...props} busy/>);
  expect(post).toHaveBeenLastCalledWith({type:"converter-visibility",visible:false},location.origin);
  view.rerender(<PianoSheet {...props} busy={false} active={false}/>);
  fireEvent(document,new Event('visibilitychange'));
  expect(post).toHaveBeenLastCalledWith({type:"converter-visibility",visible:false},location.origin);
  expect(screen.getByTitle('Piano playback')).toBe(frame);
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
