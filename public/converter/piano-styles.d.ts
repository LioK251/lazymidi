export {};
declare global {
  interface Window {
    PianoStyles: {
      styles: Record<string, {name:string;description:string}>;
      preview(canvas:HTMLCanvasElement,id:string):void;
    };
  }
}
