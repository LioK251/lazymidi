import {VexFlowMeasure} from "opensheetmusicdisplay";
import type Vex from "vexflow";
import type {GraphicalMusicSheet,MusicSystem,VexFlowGraphicalNote,VexFlowVoiceEntry} from "opensheetmusicdisplay";

type EngravedBeam=Vex.Flow.Beam&{postFormatted:boolean;slope:number;y_shift:number;render_options:{beam_width:number;partial_beam_length:number}};
type EngravedNote=Vex.Flow.StaveNote&{hasFlag():boolean;beam:EngravedBeam|null};
const spacedConstructors=new WeakSet<Function>();
function fixVoiceSpacing(value:Vex.Flow.StemmableNote){
  const ctor=value.constructor as typeof Vex.Flow.StaveNote;
  if(!ctor.format||spacedConstructors.has(ctor))return;
  spacedConstructors.add(ctor);
  const format=ctor.format;
  // shortcut: OSMD 1.9.3 omits flag clearance between voices; recheck on an engraver upgrade.
  ctor.format=function(notes,state){
    for(const note of (notes??[]) as EngravedNote[]){
      note.setXShift(0);
      // VexFlow caches beam slopes and extended stems across OSMD resizes.
      if(note.beam){note.getStem().setExtension(note.getStemExtension());note.beam.postFormatted=false;}
    }
    const result=format.call(this,notes,state);
    const placed:{stave:Vex.Flow.Stave;low:number;high:number;width:number;x:number}[]=[];
    let extra=0;
    for(const note of ([...notes??[]] as EngravedNote[]).sort((a,b)=>a.x_shift-b.x_shift)){
      if(note.isRest())continue;
      const lines=note.getKeyProps().map(p=>p.line),stem=note.hasStem()?note.getStemLength()/10:0;
      const low=Math.min(...lines)-(note.getStemDirection()===-1?stem:0)-.6;
      const high=Math.max(...lines)+(note.getStemDirection()===1?stem:0)+.6;
      const width=note.getVoiceShiftWidth()+(note.hasFlag()&&!note.beam?note.flag.getMetrics().width:0)+3;
      const previous=note.x_shift,stave=note.getStave();
      let x=previous;
      for(const other of placed){
        if(other.stave!==stave||high<=other.low||low>=other.high)continue;
        if(x<other.x+other.width&&x+width>other.x)x=other.x+other.width;
      }
      note.setXShift(x);extra=Math.max(extra,x-previous);
      placed.push({stave,low,high,width,x});
    }
    state.right_shift+=extra;
    return result;
  };
}

const spacedBeams=new WeakSet<Vex.Flow.Beam>();
function fixBeamSpacing(notes:EngravedNote[]){
  for(const beam of new Set(notes.map(note=>note.beam))){
    if(!beam||spacedBeams.has(beam))continue;
    spacedBeams.add(beam);
    const calculate=beam.calculateSlope;
    // VexFlow only checks a beam's own notes when choosing its height.
    beam.calculateSlope=()=>{
      calculate.call(beam);
      const group=beam.getNotes(),first=group[0],direction=first.getStemDirection();
      const x=first.getStemX(),y=first.getStemExtents().topY;
      const left=Math.min(...group.map(note=>note.getStemX()))-beam.render_options.partial_beam_length;
      const right=Math.max(...group.map(note=>note.getStemX()))+beam.render_options.partial_beam_length;
      const thickness=(beam.getBeamCount()*1.5-.5)*beam.render_options.beam_width;
      for(const note of notes){
        if(note.beam===beam)continue;
        const a=note.getNoteHeadBeginX()-note.getExtraLeftPx(),b=note.getNoteHeadEndX()+note.getExtraRightPx();
        if(b<left||a>right)continue;
        const target=direction===1?Math.min(...note.getYs())-8:Math.max(...note.getYs())+8;
        const edge=beam.slope*direction>0?Math.min(b,right):Math.max(a,left);
        const inner=y+beam.y_shift+(edge-x)*beam.slope+thickness*direction;
        beam.y_shift-=Math.max(0,(inner-target)*direction)*direction;
      }
    };
  }
}

const finalizeTuplets=VexFlowMeasure.prototype.finalizeTuplets;
VexFlowMeasure.prototype.finalizeTuplets=function(){
  finalizeTuplets.call(this);
  // shortcut: OSMD 1.9.3 loses isolated/hidden tuplet durations; recheck on an engraver upgrade.
  for(const entry of this.staffEntries)for(const voice of entry.graphicalVoiceEntries){
    const value=(voice as VexFlowVoiceEntry).vfStaveNote,length=voice.notes[0]?.sourceNote.Length;
    if(!value||!length||voice.parentVoiceEntry.IsGrace)continue;
    fixVoiceSpacing(value);
    const written=value.getIntrinsicTicks(),exact=value.getTicks().clone().set(length.GetExpandedNumerator(),length.Denominator);
    value.getTickMultiplier().set(1,1);
    value.setDuration(exact);
    // Written ticks control flags and beams independently of the tuplet's elapsed time.
    const ticks=value.getTicks();
    value.getTickMultiplier().set(ticks.numerator,ticks.denominator*Number(written));
    value.setIntrinsicTicks(written);
  }
};

const finalizeBeams=VexFlowMeasure.prototype.finalizeBeams;
VexFlowMeasure.prototype.finalizeBeams=function(){
  finalizeBeams.call(this);
  const notes=this.staffEntries.flatMap(entry=>entry.graphicalVoiceEntries.map(voice=>(voice as VexFlowVoiceEntry).vfStaveNote))
    .filter(note=>note&&!note.isRest()) as EngravedNote[];
  fixBeamSpacing(notes);
};

export function scorePosition(times:number[],time:number):number {
  let low=0,high=times.length;
  while(low<high){const mid=(low+high)>>>1;if(times[mid]<=time)low=mid+1;else high=mid;}
  return Math.max(0,low-1);
}

export type ScoreLayout={starts:number[];lines:{system:MusicSystem;beats:number[];positions:number[]}[];notes:WeakMap<Element,number>};

export function scoreLayout(sheet:GraphicalMusicSheet):ScoreLayout {
  const lines:ScoreLayout["lines"]=[],notes=new WeakMap<Element,number>();
  for(const page of sheet.MusicPages)for(const system of page.MusicSystems){
    const measures=system.GraphicalMeasures.flat().filter(Boolean);
    const first=measures[0],last=measures.at(-1);
    if(!first||!last)continue;
    const start=first.parentSourceMeasure.AbsoluteTimestamp.RealValue*4;
    const end=(last.parentSourceMeasure.AbsoluteTimestamp.RealValue+last.parentSourceMeasure.Duration.RealValue)*4;
    const columns=new Map<number,number>();
    let startX=first.PositionAndShape.AbsolutePosition.x+first.beginInstructionsWidth;
    for(const measure of measures)for(const entry of measure.staffEntries){
      const beat=entry.getAbsoluteTimestamp().RealValue*4;
      for(const voice of entry.graphicalVoiceEntries){
        const node=(voice.notes[0] as VexFlowGraphicalNote|undefined)?.getSVGGElement();
        if(node)notes.set(node,beat);
        const value=(voice as VexFlowVoiceEntry).vfStaveNote;
        if(!value||voice.parentVoiceEntry.IsGrace)continue;
        // Shared tick columns exclude centred rests and displaced chord heads. Six pixels centres a normal head.
        const x=(value.getAbsoluteX()-(value.isCenterAligned()?value.getCenterXShift():0)+6)/10;
        columns.set(beat,Math.min(columns.get(beat)??x,x));
        if(measure===first)startX=x-value.getTickContext().getX()/10;
      }
    }
    if(!columns.size)continue;
    if(!columns.has(start))columns.set(start,startX);
    columns.set(end,Math.max(system.GetRightBorderAbsoluteXPosition(),...columns.values()));
    const beats=[...columns.keys()].sort((a,b)=>a-b);
    lines.push({system,beats,positions:beats.map(beat=>columns.get(beat)!)});
  }
  return {lines,starts:lines.map(line=>line.beats[0]),notes};
}

export function scoreCursor(layout:ScoreLayout,beat:number){
  const line=layout.lines[scorePosition(layout.starts,beat)];
  if(!line)return;
  const index=Math.min(scorePosition(line.beats,beat),line.beats.length-2);
  const progress=Math.max(0,Math.min(1,(beat-line.beats[index])/(line.beats[index+1]-line.beats[index])));
  return {system:line.system,x:line.positions[index]+progress*(line.positions[index+1]-line.positions[index])};
}
