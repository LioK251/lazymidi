import {afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {SheetText,SheetTools,transposeValues,transposeSequence} from "./SheetText";

afterEach(cleanup);
it("preserves heading order, signs and duplicates and rejects malformed headings",()=>{
  expect(transposeSequence("Transpose by: +4\na\nTranspose by: -3\nTranspose by: -3\n<!-- Transpose by: 9 -->")).toEqual([4,-3,-3]);
  for(const text of ["Transpose by: 1.5","Transpose by: nope","Transpose by: 3 trailing"])
    expect(()=>transposeSequence(text)).toThrow("invalid value");
});
it("preserves exact sheet text while coloring timing, Ctrl notes and metadata safely",()=>{
  const text="Transpose by: -2\n\n[etu] - :1, w... e| r– t-y\n<!-- BPM: 120 -->\n| = long break\n<img src=x onerror=alert(1)>";
  render(<SheetText text={text}/>);
  const sheet=screen.getByLabelText("Piano sheet");
  expect(sheet.textContent).toBe(text);
  const chords=sheet.querySelectorAll<HTMLElement>(".sheet-chord");
  expect(chords[0].textContent).toBe("[etu] - ");
  expect(chords[0].style.color).toBe("rgb(192, 192, 90)");
  expect(chords[1].style.color).toBe("rgb(154, 218, 90)");
  expect(sheet.querySelector(".sheet-extended")?.textContent).toBe(":1");
  expect(sheet.querySelector(".sheet-comment")?.textContent).toBe("<!-- BPM: 120 -->");
  expect(sheet.querySelector("img")).toBeNull();
});
it("keeps uncolored text exact and copies only real transpose instructions",async()=>{
  const text="Transpose by: -2\n[etu]\nTranspose by: +3\n<!-- Transpose by: 99 -->";
  expect(transposeValues(text)).toBe("-2 3");
  const copy=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:copy}});
  render(<><SheetTools text={text} colored={false} onColored={vi.fn()} centered={false} onCentered={vi.fn()} zoom={1} onZoom={vi.fn()} onError={vi.fn()}/><SheetText text={text} colored={false}/></>);
  expect(screen.getByLabelText("Piano sheet").textContent).toBe(text);
  expect(screen.getByLabelText("Piano sheet").querySelector(".sheet-chord")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Copy sheet"}));
  fireEvent.click(screen.getByRole("button",{name:"Copy transposes"}));
  expect(copy.mock.calls).toEqual([[text],["-2 3"]]);
});
