import {invoke,convertFileSrc} from "@tauri-apps/api/core";
export type Values=Record<string,unknown>;
export type Point={chord:number;value:number};
export type SheetContent={text?:string;image?:string;sheets_filename?:string;revision?:number;source?:{midi_filename:string;settings:Values;line_chord_map:number[]}};
export const transposeModes={auto:"Auto",multi:"Multi",manual:"Manual",none:"Original"};
export const defaults:Values={always_open_float:false,resilience:2,place_shifted_notes:"start",place_out_of_range_notes:"inorder",break_lines_how:"manually",break_lines_every:4,quantize:35,classic_chord_order:true,sequential_quantizes:false,curly_braces_for_quantized_chords:false,include_out_of_range:true,show_tempo_timing_marks:true,show_out_of_range_text_marks:true,out_of_range_separator:":",show_bpm_changes_as_comments:true,transpose_mode:"auto",manual_transpose_points:[],visualizer_style:"classic",visualizer_speed:200,visualizer_labels:true,visualizer_particles:true,visualizer_scenes:{},hand_color_mode:"hands",hand_left_color:"#38bdf8",hand_right_color:"#f472b6",download_hands:true};
export const converterRequest=<T,>(path:string,body?:unknown):Promise<T>=>invoke("converter_request",{method:body===undefined?"GET":"POST",path,body:body??null});
export const converterAsset=(scope:string,name:string)=>convertFileSrc(`${scope}/${name}`,"converter");
export const visualizerSetting=(key:string)=>key.startsWith("visualizer_")||key.startsWith("hand_")||key==="download_hands";
export function gamePoints(settings:Values):Point[]{return ((settings.manual_transpose_points??[]) as Point[]).map(p=>({...p,value:-p.value}));}
