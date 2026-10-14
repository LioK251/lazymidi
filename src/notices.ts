import {useCallback,useEffect,useRef,useState} from 'react';

export function useNotice(): [string,(text:string|null)=>void] {
  const [text,setText]=useState('');
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const show=useCallback((next:string|null)=>{
    clearTimeout(timer.current);
    setText(next??'');
    timer.current=next?setTimeout(()=>setText(''),10000):undefined;
  },[]);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  return [text,show];
}

// Snapshots repeat an existing error; only a changed value is a new occurrence.
export function useNoticeText(text:string|null|undefined) {
  const [visible,show]=useNotice();
  useEffect(()=>{show(text??'');},[text,show]);
  return visible;
}
