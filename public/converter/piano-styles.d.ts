export {};
declare global {
  interface Window {
    PianoStyles: {
      styles: Record<string, {name:string;description:string}>;
      keyboardStyles: Record<string,string>;
      normalizeKeyboard(value:unknown):string;
      preview(canvas:HTMLCanvasElement,id:string):void;
    };
  }
}
