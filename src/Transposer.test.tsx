import {afterEach,expect,it,vi} from "vitest";
import {cleanup,render,screen} from "@testing-library/react";
import Transposer from "./Transposer";
import * as api from "./backend";

afterEach(cleanup);

it("tracks game state without manual sync or resume controls on the main page",()=>{
  const state=api.initialState();
  const send=vi.fn();
  render(<Transposer state={state} profile={state.settings.profiles[0]} edit={vi.fn()} send={send} apply={vi.fn()} discard={vi.fn()} dirty={false} busy={false}/>);
  expect(screen.queryByRole("button",{name:"Sync current value"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Resume"})).toBeNull();
  expect(screen.queryByLabelText("Current game value")).toBeNull();
  expect(screen.getByText("Automatically tracks from 0. Use shortcuts or the floating monitor while playing.")).toBeTruthy();
  expect(screen.getByRole("button",{name:"Float monitor"})).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
});
