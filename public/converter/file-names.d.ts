export {};
declare global {
  interface Window {
    ConverterNames: {display(name:string):string;download(name:string):string};
  }
}
