import {expect,it} from "vitest";
import Vex from "vexflow";
import {Fraction,VexFlowMeasure} from "opensheetmusicdisplay";
import type {GraphicalMusicSheet} from "opensheetmusicdisplay";
import {scoreCursor,scoreLayout} from "./piano-score";

it('formats isolated tuplets, hidden rests and whole notes without changing their written values',()=>{
  const eighth=()=>new Vex.Flow.StaveNote({keys:['c/4'],duration:'8'});
  const triplet=[eighth(),eighth(),eighth()];
  new Vex.Flow.Tuplet(triplet,{num_notes:3,notes_occupied:2,ratioed:false});
  const values=[eighth(),new Vex.Flow.GhostNote({duration:'8'}),...triplet,
    new Vex.Flow.StaveNote({keys:['c/4'],duration:'w'})];
  const lengths=values.map((_,i)=>new Fraction(1,i===values.length-1?1:12));
  const writtenTicks=values.map(value=>value.getIntrinsicTicks());
  const grace=new Vex.Flow.GraceNote({keys:['d/4'],duration:'16'}),graceTicks=grace.getTicks().value();
  const measure=Object.assign(Object.create(VexFlowMeasure.prototype),{tuplets:{},staffEntries:[{
    graphicalVoiceEntries:[...values.map((vfStaveNote,i)=>({vfStaveNote,notes:[{sourceNote:{Length:lengths[i]}}],parentVoiceEntry:{IsGrace:false}})),
      {vfStaveNote:grace,notes:[{sourceNote:{Length:new Fraction(0,1)}}],parentVoiceEntry:{IsGrace:true}}]
  }]});
  for(let redraw=0;redraw<2;redraw++){
    measure.finalizeTuplets();
    values.forEach((value,i)=>{
      expect(value.getTicks().value()).toBeCloseTo(lengths[i].RealValue*Vex.Flow.RESOLUTION);
      expect(value.getIntrinsicTicks()).toBe(writtenTicks[i]);
    });
    expect(grace.getTicks().value()).toBe(graceTicks);
  }
});

it('follows time columns through centred rests, simultaneous voices, gaps and line changes',()=>{
  function system(start:number,entries:[number,number,number][],right:number){
    const measure={parentSourceMeasure:{AbsoluteTimestamp:new Fraction(start,4),Duration:new Fraction(1,1)},
      PositionAndShape:{AbsolutePosition:{x:5,y:5+start*5}},beginInstructionsWidth:5,
      staffEntries:entries.map(([beat,x,centre])=>({getAbsoluteTimestamp:()=>new Fraction(beat,4),
        graphicalVoiceEntries:[{parentVoiceEntry:{IsGrace:false},notes:[],vfStaveNote:{getAbsoluteX:()=>x+centre,
          isCenterAligned:()=>!!centre,getCenterXShift:()=>centre,getTickContext:()=>({getX:()=>x-100})}}]}))};
    return {GraphicalMeasures:[[measure]],GetRightBorderAbsoluteXPosition:()=>right};
  }
  const first=system(0,[[0,100,240],[1,150,0],[1,150,20],[3.75,410,0]],40);
  const second=system(4,[[5,180,0],[6,220,0]],32);
  const layout=scoreLayout({MusicPages:[{MusicSystems:[first,second]}]} as unknown as GraphicalMusicSheet);
  expect(layout.lines[0].beats).toEqual([0,1,3.75,4]);
  expect(scoreCursor(layout,0)?.x).toBeCloseTo(10.6);
  expect(scoreCursor(layout,.5)?.x).toBeCloseTo(13.1);
  let previous=0;
  for(let beat=0;beat<4;beat+=.01){const x=scoreCursor(layout,beat)!.x;expect(x).toBeGreaterThanOrEqual(previous);previous=x;}
  expect(scoreCursor(layout,4)?.system).toBe(second);
  expect(scoreCursor(layout,4)?.x).toBeCloseTo(10.6);
  expect(scoreCursor(layout,100)?.x).toBe(32);
  expect(scoreCursor(layout,.5)?.x).toBeCloseTo(13.1);
  expect(scoreCursor({starts:[],lines:[],notes:new WeakMap()},0)).toBeUndefined();
});
