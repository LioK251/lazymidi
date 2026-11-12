import {expect,it} from "vitest";
import Vex from "vexflow";
import {Fraction,VexFlowMeasure} from "opensheetmusicdisplay";
import type {GraphicalMusicSheet} from "opensheetmusicdisplay";
import {scoreCursor,scoreLayout} from "./piano-score";

it.each([2,3])('keeps %i simultaneous voices clear of flags and reserves their width on every layout',count=>{
  const values=[
    new Vex.Flow.StaveNote({keys:['f#/4'],duration:'32',stem_direction:1}),
    new Vex.Flow.StaveNote({keys:['d/4','d/5'],duration:'8',stem_direction:-1}),
    new Vex.Flow.StaveNote({keys:['b/4'],duration:'16',stem_direction:-1}),
  ].slice(0,count);
  for(const value of values)new Vex.Flow.Voice({num_beats:4,beat_value:4,resolution:Vex.Flow.RESOLUTION}).setStrict(false).addTickable(value);
  const measure=Object.assign(Object.create(VexFlowMeasure.prototype),{tuplets:{},staffEntries:[{
    graphicalVoiceEntries:values.map(vfStaveNote=>({vfStaveNote,notes:[{sourceNote:{Length:new Fraction(1,Number(vfStaveNote.getDuration()))}}],parentVoiceEntry:{IsGrace:false}}))
  }]});
  measure.finalizeTuplets();
  const originalTicks=values.map(value=>value.getTicks().value());
  let positions:number[]|undefined;
  for(let redraw=0;redraw<3;redraw++){
    const state={left_shift:0,right_shift:0,text_line:0};
    Vex.Flow.StaveNote.format(values,state);
    const ordered=[...values].sort((a,b)=>a.x_shift-b.x_shift);
    for(let i=1;i<ordered.length;i++){
      const previous=ordered[i-1];
      const right=previous.x_shift+previous.getVoiceShiftWidth()+previous.flag.getMetrics().width;
      expect(ordered[i].x_shift-right).toBeGreaterThanOrEqual(3);
    }
    expect(state.right_shift).toBeGreaterThan(0);
    const next=values.map(value=>value.x_shift);
    if(positions)expect(next).toEqual(positions);
    positions=next;
    expect(values.map(value=>value.getTicks().value())).toEqual(originalTicks);
  }
});

it('separates touching whole-note heads between voices',()=>{
  const stave=new Vex.Flow.Stave(0,0,400);
  const values=['a/3','f/3'].map((key,i)=>new Vex.Flow.StaveNote({keys:[key],duration:'w',clef:'bass',stem_direction:i?-1:1}));
  for(const value of values)value.setStave(stave);
  const state={left_shift:0,right_shift:0,text_line:0};
  Vex.Flow.StaveNote.format(values,state);
  const [left,right]=values.sort((a,b)=>a.x_shift-b.x_shift);
  expect(right.x_shift-left.x_shift).toBeGreaterThanOrEqual(left.getVoiceShiftWidth()+3);
});

it('keeps beams joined to their stems when a measure is resized',()=>{
  const stave=new Vex.Flow.Stave(0,0,160);
  const notes=['c/5','g/5'].map(key=>new Vex.Flow.StaveNote({keys:[key],duration:'8',stem_direction:-1}));
  for(const note of notes)note.setStave(stave);
  const beam=new Vex.Flow.Beam(notes) as Vex.Flow.Beam&{slope:number};
  const voice=new Vex.Flow.Voice({num_beats:4,beat_value:4,resolution:Vex.Flow.RESOLUTION}).setStrict(false).addTickables(notes);
  for(const width of [160,500,160]){
    stave.setWidth(width);
    new Vex.Flow.Formatter().joinVoices([voice]).formatToStave([voice],stave);
    beam.postFormat();
    const start=notes[0].getStemExtents().topY;
    const end=start+(notes[1].getStemX()-notes[0].getStemX())*beam.slope;
    expect(end).toBeCloseTo(notes[1].getStemExtents().topY);
  }
});

it.each([1,-1])('keeps a beam clear of other voices with stem direction %i',direction=>{
  const stave=new Vex.Flow.Stave(0,0,160);
  const notes=(direction===1?['c/4','g/4']:['g/5','c/5']).map(key=>new Vex.Flow.StaveNote({keys:[key],duration:'8',stem_direction:direction}));
  const other=new Vex.Flow.StaveNote({keys:[direction===1?'b/4':'a/4'],duration:'q',stem_direction:direction});
  const values=[...notes,other];
  for(const value of values)value.setStave(stave);
  const beam=new Vex.Flow.Beam(notes) as Vex.Flow.Beam&{slope:number};
  const voices=[notes,[other]].map(values=>new Vex.Flow.Voice({num_beats:4,beat_value:4,resolution:Vex.Flow.RESOLUTION}).setStrict(false).addTickables(values));
  const measure=Object.assign(Object.create(VexFlowMeasure.prototype),{beams:{},rules:{},tuplets:{},staffEntries:[{
    graphicalVoiceEntries:values.map(vfStaveNote=>({vfStaveNote,notes:[{sourceNote:{Length:new Fraction(1,vfStaveNote===other?4:8)}}],parentVoiceEntry:{IsGrace:false}}))
  }]});
  measure.finalizeBeams();
  measure.finalizeTuplets();
  for(const width of [160,500,160]){
    stave.setWidth(width);
    new Vex.Flow.Formatter().joinVoices(voices).formatToStave(voices,stave);beam.postFormat();
    const x=(other.getNoteHeadBeginX()+other.getNoteHeadEndX())/2;
    const edge=notes[0].getStemExtents().topY+(x-notes[0].getStemX())*beam.slope+5*direction;
    expect((other.getYs()[0]-edge)*direction).toBeGreaterThanOrEqual(8);
  }
});

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
  first.GraphicalMeasures[0].unshift(undefined as any);
  first.GraphicalMeasures.push([undefined as any]);
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
