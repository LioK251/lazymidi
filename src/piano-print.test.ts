import {afterEach,expect,it,vi} from "vitest";
import {printPiano} from "./piano-print";

const {instances,fault}=vi.hoisted(()=>({instances:[] as any[],fault:{load:false}}));
vi.mock("opensheetmusicdisplay",()=>({
  VexFlowMeasure:class{finalizeTuplets(){}},
  OpenSheetMusicDisplay:class {
    EngravingRules={TitleTopDistance:5,SheetTitleHeight:4};Sheet={TitleString:'',SubtitleString:''};clear=vi.fn();
    constructor(public node:HTMLElement,public options:object){instances.push(this);}
    async load(){if(fault.load)throw new Error('Unreadable score');}
    render(){this.node.append(this.node.ownerDocument.createElementNS('http://www.w3.org/2000/svg','svg'));}
  }
}));
afterEach(()=>{vi.restoreAllMocks();instances.length=0;fault.load=false;});

it('prints a separate A4 score, waits for the dialog, and removes temporary pages afterward',async()=>{
  document.title='lazymidi';
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({measureText:(text:string)=>({width:text.length*14})} as unknown as CanvasRenderingContext2D);
  const append=document.body.append.bind(document.body);
  let frame:HTMLIFrameElement;
  let printed:()=>void=()=>{};
  const printing=new Promise<void>(resolve=>{printed=resolve;});
  vi.spyOn(document.body,'append').mockImplementation((...nodes)=>{
    append(...nodes);frame=nodes[0] as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow!,'focus').mockImplementation(()=>{});
    vi.spyOn(frame.contentWindow!,'print').mockImplementation(()=>printed());
  });
  const title='A & B — 夜のピアノ: a very long song title with a second movement and more words';
  const pending=printPiano('<score-partwise/>',title);
  await printing;
  const printingTitle=document.title;
  const osmd=instances[0];
  expect(osmd.options).toMatchObject({pageFormat:'A4_P',drawTitle:true,drawSubtitle:true});
  expect(osmd.Sheet.TitleString.replace(/\n/g,' ')).toBe(title);
  expect(osmd.Sheet.TitleString.split('\n').every((line:string)=>line.length<=49)).toBe(true);
  expect(osmd.Sheet.SubtitleString).toBe('lazymidi');
  expect(osmd.EngravingRules.TitleTopDistance).toBe(9);
  expect(osmd.EngravingRules.AutoGenerateMultipleRestMeasuresFromRestMeasures).toBe(false);
  expect(frame!.isConnected).toBe(true);
  frame!.contentWindow!.dispatchEvent(new Event('afterprint'));
  await pending;
  expect(printingTitle).toBe(title);
  expect(document.title).toBe('lazymidi');
  expect(frame!.isConnected).toBe(false);expect(osmd.clear).toHaveBeenCalledOnce();
});

it('cleans up and reports a score that cannot be prepared for printing',async()=>{
  fault.load=true;
  await expect(printPiano('invalid','Song')).rejects.toThrow('Unreadable score');
  expect(document.querySelector('iframe[title="Printable piano score"]')).toBeNull();
  expect(instances[0].clear).toHaveBeenCalledOnce();
});

it('restores the parent title when the print dialog cannot open',async()=>{
  document.title='lazymidi';
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({measureText:()=>({width:50})} as unknown as CanvasRenderingContext2D);
  const append=document.body.append.bind(document.body);
  vi.spyOn(document.body,'append').mockImplementation((...nodes)=>{
    append(...nodes);const frame=nodes[0] as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow!,'focus').mockImplementation(()=>{});
    vi.spyOn(frame.contentWindow!,'print').mockImplementation(()=>{
      expect(document.title).toBe('Song');
      throw new Error('Print dialog unavailable');
    });
  });
  await expect(printPiano('<score-partwise/>','Song')).rejects.toThrow('Print dialog unavailable');
  expect(document.title).toBe('lazymidi');
  expect(document.querySelector('iframe[title="Printable piano score"]')).toBeNull();
});
