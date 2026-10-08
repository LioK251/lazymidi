import { useEffect, useRef, useState } from "react";
import type { Profile, Snapshot } from "./backend";

const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const black = (note: number) => [1, 3, 6, 8, 10].includes(note % 12);
const noteName = (note: number) =>
  `${names[note % 12]}${Math.floor(note / 12) - 1}`;
const label = (hid: number) =>
  hid >= 4 && hid <= 29
    ? String.fromCharCode(hid + 61)
    : hid >= 30 && hid <= 38
      ? String(hid - 29)
      : hid === 39
        ? "0"
        : hid === 44
          ? "Space"
          : `HID ${hid}`;
const codeToHid = (code: string): number | null => {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
  if (/^Digit[1-9]$/.test(code)) return +code.slice(5) + 29;
  if (code === "Digit0") return 39;
  return (
    (
      {
        Enter: 40,
        Escape: 41,
        Backspace: 42,
        Tab: 43,
        Space: 44,
        Minus: 45,
        Equal: 46,
        BracketLeft: 47,
        BracketRight: 48,
        Backslash: 49,
        Semicolon: 51,
        Quote: 52,
        Backquote: 53,
        Comma: 54,
        Period: 55,
        Slash: 56,
        ShiftLeft: 225,
        ShiftRight: 229,
        ControlLeft: 224,
        ControlRight: 228,
        AltLeft: 226,
        AltRight: 230,
        MetaLeft: 227,
        MetaRight: 231,
      } as Record<string, number>
    )[code] ?? null
  );
};
const notes = Array.from({ length: 88 }, (_, i) => i + 21);
const whites = notes.filter((n) => !black(n));

export default function Piano88({
  profile,
  direction,
  onDirection,
  active,
  edit,
  busy,
}: {
  profile: Profile;
  direction: "analog" | "qwerty";
  onDirection: (direction: "analog" | "qwerty") => void;
  active: Snapshot["active_notes"];
  edit: (change: (p: Profile) => void) => void;
  busy: boolean;
}) {
  const [channel, setChannel] = useState(0);
  const [selected, setSelected] = useState(60);
  const [hid, setHid] = useState(4);
  const [shift, setShift] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [capture, setCapture] = useState(false);
  const [message, setMessage] = useState("");
  const captureRef = useRef<HTMLButtonElement>(null);
  const binding =
    direction === "analog"
      ? profile.analog.keymapping[String(channel)]?.find(
          ([, n]) => n === selected,
        )?.[0]
      : profile.qwerty.find((b) => b.channel === channel && b.note === selected)
          ?.hid;
  const bindingModifiers =
    direction === "qwerty"
      ? (profile.qwerty.find(
          (b) => b.channel === channel && b.note === selected,
        )?.modifiers ?? [])
      : [];
  const bindingKey = JSON.stringify(bindingModifiers);
  useEffect(() => {
    setHid(binding ?? 4);
    setShift(bindingModifiers.includes(225) || bindingModifiers.includes(229));
    setCtrl(bindingModifiers.includes(224) || bindingModifiers.includes(228));
    setCapture(false);
  }, [binding, bindingKey, channel, selected, direction]);
  function assign(key: number, withShift: boolean, withCtrl: boolean) {
    edit((p) => {
      if (direction === "analog") {
        const pairs = p.analog.keymapping[String(channel)] ?? [];
        p.analog.keymapping[String(channel)] = pairs
          .filter(([h, n]) => n !== selected && h !== key)
          .concat([[key, selected]]);
      } else {
        p.qwerty = p.qwerty.filter(
          (b) => !(b.channel === channel && b.note === selected),
        );
        p.qwerty.push({
          channel,
          note: selected,
          hid: key,
          modifiers: [...(withCtrl ? [224] : []), ...(withShift ? [225] : [])],
        });
      }
    });
    setCapture(false);
    setMessage(
      `${noteName(selected)} assigned to ${withCtrl ? "Ctrl + " : ""}${withShift ? "Shift + " : ""}${label(key)} in your draft.`,
    );
  }
  function remove() {
    edit((p) => {
      if (direction === "analog")
        p.analog.keymapping[String(channel)] = (
          p.analog.keymapping[String(channel)] ?? []
        ).filter(([, n]) => n !== selected);
      else
        p.qwerty = p.qwerty.filter(
          (b) => !(b.channel === channel && b.note === selected),
        );
    });
    setMessage(`${noteName(selected)} unassigned in your draft.`);
  }
  return (
    <section className="piano-panel" aria-label="88-key piano mapping">
      <div className="piano-heading">
        <h2>88-key piano</h2>
        <select
          className="piano-direction"
          aria-label="Mapping direction"
          value={direction}
          onChange={(e) => onDirection(e.target.value as "analog" | "qwerty")}
        >
          <option value="analog">Analog → MIDI</option>
          <option value="qwerty">MIDI → QWERTY</option>
        </select>
        <label className="inline-label">
          Channel
          <select
            aria-label="Piano mapping channel"
            value={channel}
            onChange={(e) => setChannel(+e.target.value)}
          >
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="piano" role="group" aria-label="Piano notes A0 to C8">
        {notes.map((note) => {
          const isBlack = black(note);
          const index = whites.filter((n) => n < note).length;
          const mapped =
            direction === "analog"
              ? profile.analog.keymapping[String(channel)]
                  ?.filter(([, n]) => n === note)
                  .map(([h]) => label(h))
                  .join(" / ")
              : profile.qwerty
                  .filter((b) => b.channel === channel && b.note === note)
                  .map(
                    (b) =>
                      `${b.modifiers?.includes(224) ? "^" : ""}${b.modifiers?.includes(225) ? (({ "1": "!", "2": "@", "4": "$", "5": "%", "6": "^", "8": "*", "9": "(" } as Record<string, string>)[label(b.hid)] ?? label(b.hid)) : label(b.hid).toLowerCase()}`,
                  )
                  .join(" / ");
          const lit = active.some(([, c, n]) => c === channel && n === note);
          const left = isBlack
            ? ((index - 0.32) / 52) * 100
            : (index / 52) * 100;
          return (
            <button
              key={note}
              id={`piano-note-${note}`}
              tabIndex={selected === note ? 0 : -1}
              className={`piano-key ${isBlack ? "black" : "white"} ${selected === note ? "selected" : ""} ${lit ? "sounding" : ""}`}
              style={{
                left: `${left}%`,
                width: `${((isBlack ? 0.64 : 1) / 52) * 100}%`,
              }}
              aria-label={`${noteName(note)} MIDI ${note}${mapped ? `, mapped to ${mapped}` : ", unassigned"}`}
              aria-pressed={selected === note}
              title={`${noteName(note)} · MIDI ${note}${mapped ? ` · ${mapped}` : ""}`}
              onClick={() => {
                setSelected(note);
                setMessage("");
              }}
              onKeyDown={(e) => {
                const offset = (
                  {
                    ArrowLeft: -1,
                    ArrowRight: 1,
                    ArrowUp: 12,
                    ArrowDown: -12,
                  } as Record<string, number>
                )[e.key];
                if (
                  offset !== undefined ||
                  e.key === "Home" ||
                  e.key === "End"
                ) {
                  e.preventDefault();
                  const next =
                    e.key === "Home"
                      ? 21
                      : e.key === "End"
                        ? 108
                        : Math.max(21, Math.min(108, note + offset));
                  setSelected(next);
                  document.getElementById(`piano-note-${next}`)?.focus();
                }
              }}
            >
              <small>{names[note % 12] === "C" ? noteName(note) : ""}</small>
              <span>{mapped ?? ""}</span>
            </button>
          );
        })}
      </div>
      <div className="piano-assignment">
        <span className="selected-note">
          {noteName(selected)} <small>MIDI {selected}</small>
        </span>
        <label className="inline-label">
          HID
          <input
            aria-label="Selected piano key HID"
            type="number"
            min="4"
            max="231"
            value={hid}
            onChange={(e) => setHid(+e.target.value)}
          />
        </label>
        {direction === "qwerty" && (
          <label className="toggle">
            <input
              aria-label="Shift modifier for piano output"
              type="checkbox"
              checked={shift}
              onChange={(e) => setShift(e.target.checked)}
            />
            Shift
          </label>
        )}
        {direction === "qwerty" && (
          <label className="toggle">
            <input
              aria-label="Ctrl modifier for piano output"
              type="checkbox"
              checked={ctrl}
              onChange={(e) => setCtrl(e.target.checked)}
            />
            Ctrl
          </label>
        )}
        <button
          ref={captureRef}
          className={capture ? "active" : ""}
          disabled={busy}
          onClick={() => {
            setCapture(!capture);
            setMessage("");
          }}
          onKeyDown={(e) => {
            if (!capture) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.code === "Escape") {
              setCapture(false);
              return;
            }
            if (e.repeat) return;
            if (
              direction === "qwerty" &&
              [
                "ShiftLeft",
                "ShiftRight",
                "ControlLeft",
                "ControlRight",
              ].includes(e.code)
            )
              return;
            const key = codeToHid(e.code);
            if (key === null) {
              setMessage("Use a letter, number, or supported physical key.");
              return;
            }
            assign(
              key,
              direction === "qwerty" && e.shiftKey,
              direction === "qwerty" && e.ctrlKey,
            );
          }}
        >
          {capture ? "Press a physical key…" : "Capture key"}
        </button>
        <button disabled={busy} onClick={() => assign(hid, shift, ctrl)}>
          Assign
        </button>
        <button disabled={binding === undefined || busy} onClick={remove}>
          Unassign
        </button>
        <span className="piano-message" role="status">
          {message || (capture ? "Escape cancels." : "")}
        </span>
      </div>
      {direction === "analog" && <AnalogResponse profile={profile} edit={edit} />}
    </section>
  );
}

export function AnalogResponse({ profile, edit }: {
  profile: Profile;
  edit: (change: (profile: Profile) => void) => void;
}) {
  return (
    <div className="analog-response">
      <label className="field">
        Shift amount <span className="muted">semitones</span>
        <input
          aria-label="Analog shift amount"
          title="Semitone transposition while Left Shift is held"
          type="number"
          min="-127"
          max="127"
          value={profile.analog.shift_amount}
          onChange={(e) =>
            edit((p) => (p.analog.shift_amount = +e.target.value))
          }
        />
      </label>
      <label className="field">
        Note trigger threshold
        <input
          aria-label="Analog note threshold"
          type="number"
          min="0"
          max="0.99"
          step="0.01"
          value={profile.analog.note_config.threshold}
          onChange={(e) =>
            edit((p) => (p.analog.note_config.threshold = +e.target.value))
          }
        />
      </label>
      <label className="field">
        Velocity scale
        <input
          aria-label="Analog velocity scale"
          type="number"
          min="0.01"
          max="10000"
          step="0.1"
          value={profile.analog.note_config.velocity_scale}
          onChange={(e) =>
            edit(
              (p) =>
                (p.analog.note_config.velocity_scale = +e.target.value),
            )
          }
        />
      </label>
    </div>
  );
}
