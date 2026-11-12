import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {printPiano} from "./piano-print";

const {instances,fault}=vi.hoisted(()=>({instances:[] as any[],fault:{load:false,empty:false}}));
vi.mock("opensheetmusicdisplay",()=>({
  VexFlowMeasure:class{finalizeTuplets(){}},
  OpenSheetMusicDisplay:class {
    EngravingRules={TitleTopDistance:5,SheetTitleHeight:4};Sheet={TitleString:'',SubtitleString:''};clear=vi.fn();
    constructor(public node:HTMLElement,public options:object){instances.push(this);}
    async load(){if(fault.load)throw new Error('Unreadable score');}
    render(){if(!fault.empty)this.node.append(this.node.ownerDocument.createElementNS('http://www.w3.org/2000/svg','svg'));}
  }
}));
beforeEach(()=>{
  document.title='lazymidi';
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({measureText:(text:string)=>({width:text.length*14})} as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('requestAnimationFrame',vi.fn((callback:FrameRequestCallback)=>{queueMicrotask(()=>callback(0));return 1;}));
});
afterEach(()=>{
  vi.restoreAllMocks();vi.unstubAllGlobals();instances.length=0;fault.load=false;fault.empty=false;
  document.body.replaceChildren();document.querySelectorAll('style[data-piano-print]').forEach(node=>node.remove());
});

it('prints a separate A4 score, waits for the dialog, and removes temporary pages afterward',async()=>{
  const viewer=document.createElement('div');viewer.textContent='Live score';document.body.append(viewer);
  let printed:()=>void=()=>{};
  const printing=new Promise<void>(resolve=>{printed=resolve;});
  vi.spyOn(window,'print').mockImplementation(()=>printed());
  const title='A & B — 夜のピアノ: a very long song title with a second movement and more words';
  const pending=printPiano('<score-partwise/>',title);
  await printing;
  const printingTitle=document.title;
  const osmd=instances[0];
  const paper=document.querySelector('.piano-print')!;
  expect(paper.parentElement).toBe(document.body);
  expect(osmd.node).toBe(paper);
  expect(document.querySelector('iframe')).toBeNull();
  expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  expect(osmd.options).toMatchObject({pageFormat:'A4_P',drawTitle:true,drawSubtitle:true});
  expect(osmd.Sheet.TitleString.replace(/\n/g,' ')).toBe(title);
  expect(osmd.Sheet.TitleString.split('\n').every((line:string)=>line.length<=49)).toBe(true);
  expect(osmd.Sheet.SubtitleString).toBe('lazymidi');
  expect(osmd.EngravingRules.TitleTopDistance).toBe(9);
  expect(osmd.EngravingRules.AutoGenerateMultipleRestMeasuresFromRestMeasures).toBe(false);
  expect(paper.isConnected).toBe(true);
  window.dispatchEvent(new Event('afterprint'));
  await pending;
  expect(printingTitle).toBe(title.replace(':','_')+'_lazymidi');
  expect(document.title).toBe('lazymidi');
  expect(paper.isConnected).toBe(false);expect(osmd.clear).toHaveBeenCalledOnce();
  expect(viewer.isConnected).toBe(true);expect(viewer.textContent).toBe('Live score');
  expect(document.querySelector('style[data-piano-print]')).toBeNull();
});

it('cleans up and reports a score that cannot be prepared for printing',async()=>{
  fault.load=true;
  await expect(printPiano('invalid','Song')).rejects.toThrow('Unreadable score');
  expect(document.title).toBe('lazymidi');
  expect(document.querySelector('.piano-print')).toBeNull();
  expect(document.querySelector('style[data-piano-print]')).toBeNull();
  expect(instances[0].clear).toHaveBeenCalledOnce();
});

it('restores the document and removes its listener when the print dialog cannot open',async()=>{
  const removed=vi.spyOn(window,'removeEventListener');
  vi.spyOn(window,'print').mockImplementation(()=>{
    expect(document.title).toBe('Song_lazymidi');
    throw new Error('Print dialog unavailable');
  });
  await expect(printPiano('<score-partwise/>','Song')).rejects.toThrow('Print dialog unavailable');
  expect(document.title).toBe('lazymidi');
  expect(document.querySelector('.piano-print')).toBeNull();
  expect(removed).toHaveBeenCalledWith('afterprint',expect.any(Function));
});

it.each([
  ['Wham! - Last Christmas (Piano Cover)','Wham! - Last Christmas (Piano Cover)_lazymidi'],
  ['Song_lazymidi','Song_lazymidi'],
  ['A/B: 夜のピアノ? . ','A_B_ 夜のピアノ__lazymidi'],
  [' . ','score_lazymidi'],
])('suggests a safe branded PDF name for %s and restores it after cancellation',async(title,expected)=>{
  vi.spyOn(window,'print').mockImplementation(()=>{
    expect(document.title).toBe(expected);
    expect(instances[0].Sheet.TitleString.replace(/\n/g,' ')).toBe(title.replace(/\s+/g,' ').trim());
    window.dispatchEvent(new Event('afterprint'));
  });
  await printPiano('<score-partwise/>',title);
  expect(document.title).toBe('lazymidi');
  expect(document.querySelector('.piano-print')).toBeNull();
});

it('rejects an empty print render even when the live viewer contains SVG',async()=>{
  document.body.append(document.createElementNS('http://www.w3.org/2000/svg','svg'));
  fault.empty=true;
  const print=vi.spyOn(window,'print').mockImplementation(()=>{});
  await expect(printPiano('<score-partwise/>','Song')).rejects.toThrow('No printable score was generated');
  expect(print).not.toHaveBeenCalled();
  expect(document.title).toBe('lazymidi');
});
