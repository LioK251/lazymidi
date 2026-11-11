import {VexFlowMeasure} from "opensheetmusicdisplay";
import type {GraphicalMusicSheet,MusicSystem,VexFlowGraphicalNote,VexFlowVoiceEntry} from "opensheetmusicdisplay";

const finalizeTuplets=VexFlowMeasure.prototype.finalizeTuplets;
VexFlowMeasure.prototype.finalizeTuplets=function(){
  finalizeTuplets.call(this);
  // shortcut: OSMD 1.9.3 loses isolated/hidden tuplet durations; recheck on an engraver upgrade.
  for(const entry of this.staffEntries)for(const voice of entry.graphicalVoiceEntries){
    const value=(voice as VexFlowVoiceEntry).vfStaveNote,length=voice.notes[0]?.sourceNote.Length;
    if(!value||!length||voice.parentVoiceEntry.IsGrace)continue;
    const written=value.getIntrinsicTicks(),exact=value.getTicks().clone().set(length.GetExpandedNumerator(),length.Denominator);
    value.getTickMultiplier().set(1,1);
    value.setDuration(exact);
    // Written ticks control flags and beams independently of the tuplet's elapsed time.
    const ticks=value.getTicks();
    value.getTickMultiplier().set(ticks.numerator,ticks.denominator*Number(written));
    value.setIntrinsicTicks(written);
  }
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
