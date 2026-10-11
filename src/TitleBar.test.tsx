import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import TitleBar from "./TitleBar";
const native=vi.hoisted(()=>({minimize:vi.fn(async()=>{}),toggleMaximize:vi.fn(async()=>{}),close:vi.fn(async()=>{}),isMaximized:vi.fn(async()=>false),onResized:vi.fn(async()=>()=>{})}));
vi.mock("./backend",()=>({desktop:true,errorText:(e:Error)=>e.message}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:()=>native}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("uses the same chrome for auxiliary windows without closing the app",async()=>{
  const onError=vi.fn();await act(async()=>{render(<TitleBar label="Sheet" onError={onError}/>);});
  expect(screen.getByText("lazymidi")).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Minimize window"}));fireEvent.click(screen.getByRole("button",{name:"Maximize window"}));fireEvent.click(screen.getByRole("button",{name:"Close window"}));});
  expect(native.minimize).toHaveBeenCalledOnce();expect(native.toggleMaximize).toHaveBeenCalledOnce();expect(native.close).toHaveBeenCalledOnce();expect(onError).not.toHaveBeenCalled();
});
it("retains the main window shutdown callback and reports native errors",async()=>{
  const onClose=vi.fn(),onError=vi.fn();native.minimize.mockRejectedValueOnce(new Error("Cannot minimize"));
  await act(async()=>{render(<TitleBar onClose={onClose} onError={onError}/>);});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Close window"}));fireEvent.click(screen.getByRole("button",{name:"Minimize window"}));});
  expect(onClose).toHaveBeenCalledOnce();expect(native.close).not.toHaveBeenCalled();expect(onError).toHaveBeenCalledWith("Cannot minimize");
});
