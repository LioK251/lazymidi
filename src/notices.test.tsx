import {act,renderHook,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNotice,useNoticeText} from './notices';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('expires at ten seconds, restarts identical occurrences and preserves newer notices',()=>{
  vi.useFakeTimers();const {result}=renderHook(()=>useNotice());
  act(()=>result.current[1]('first'));
  act(()=>vi.advanceTimersByTime(9000));expect(result.current[0]).toBe('first');
  act(()=>result.current[1]('first'));
  act(()=>vi.advanceTimersByTime(1000));expect(result.current[0]).toBe('first');
  act(()=>result.current[1]('second'));
  act(()=>vi.advanceTimersByTime(9000));expect(result.current[0]).toBe('second');
  act(()=>vi.advanceTimersByTime(1000));expect(result.current[0]).toBe('');
});
it('does not restart backend errors on repeated snapshots, but shows a new occurrence after clearing',()=>{
  vi.useFakeTimers();const {result,rerender}=renderHook(({text})=>useNoticeText(text),{initialProps:{text:'failed'}});
  act(()=>vi.advanceTimersByTime(9000));rerender({text:'failed'});
  act(()=>vi.advanceTimersByTime(1000));expect(result.current).toBe('');
  rerender({text:'failed'});expect(result.current).toBe('');
  rerender({text:''});rerender({text:'failed'});expect(result.current).toBe('failed');
});
