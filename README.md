# lazymidi

A compact desktop utility for playing virtual piano games with a Wooting analog keyboard or a MIDI controller. Rust engine, Tauri 2, React, TypeScript. No external MIDI cable connects its modules. Musical input sends keyboard/MIDI events; the optional converter also has an audio visualizer.

Windows downloads: [GitHub releases](https://github.com/LioK251/lazymidi/releases). Version **0.1.5** provides the current-user installer and portable ZIP. Extract the whole ZIP and keep its `_up_` resource folder beside `lazymidi.exe`; the standalone executable does not include the converter service files. Windows builds are unsigned; the Wooting SDK remains a separate installation. Experimental Apple Silicon and Intel DMGs are available as [macOS build artifacts](https://github.com/LioK251/lazymidi/actions/runs/38193422102) for macOS 14+, with ad-hoc signatures and no notarization. Linux installers and full platform hardware qualification remain outstanding.

Version 0.1.5 adds **Always open Float**, restores minimized sheet windows, saves viewer preferences and fixes generated-key typing throughout converter fields, remembers compute-device selection and adds Discord browser attachment conversion. It includes **Discord Rich Presence**, a **Transposer** with floating monitor/sheets, and an optional **Convert** module. See the [release notes](docs/releases/0.1.5.md) and [optional modules](docs/optional-modules.md).

## Optional tools

- **Discord:** presence and the GitHub Get button default On and can be disabled separately in Settings. Presence shares connected input labels only, not songs, paths or conversion history. Discord being unavailable does not interrupt playing.
- **Transposer:** assign the game's Up/Down keys, enter a sequence, and Apply. Use the compact floating monitor or global shortcuts while the game is foreground. Tracking starts from an assumed game value of 0; start the game at 0. Manual in-game changes cannot be detected. Output starts Paused; opening the monitor or sending a sheet sequence resumes and applies the selected entry when bindings are configured. Interrupted delivery pauses tracking and requires resetting the game to 0 before resuming.
- **Converter:** enable its tab in Settings (Off by default), then choose **Use existing converter environment** and select a compatible mp3converter installation or Python environment. Validation checks dependencies, Transkun's model and FFmpeg; it does not install CUDA, drivers or packages. Runtime downloads are unavailable in this release; CPU/CUDA packs are not distributed. Existing user data can be copied separately without modifying the original installation.
- **Sheets and visualizer:** Sheet generates immediately. Floating sheets support Auto/Multi/Manual/Original modes and Send to Transposer. Song cards open a separate visualizer with Basic synth or imported `.sf2` fonts, styles, hand editing and exports. Closing it stops playback and keeps its loaded font cached until lazymidi exits. Converted songs never automatically play into Roblox.

An optional Chromium extension is included in the portable ZIP and as a separate ZIP. Extract it, load `extension/` as an unpacked extension, then keep lazymidi running with Converter enabled and a compatible Python environment selected. Connection is automatic. YouTube/TikTok have page buttons; Discord browser attachments have a **Convert with lazymidi** right-click action. The current extension source replaces MuseScore's file picker with a **Download MIDI to lazymidi** button using LibreScore's download authorization method. Supported-page controls stay visible and are added to already-open tabs when the extension is installed. See [extension setup](extension/README.md); the published v0.1.5 extension ZIP predates this MuseScore update.

The converter remembers the chosen compute device immediately, including for browser submissions. Unavailable CUDA falls back to CPU without erasing the preference. Cancel is beside Convert link during a link job. Converter fields keep generated keys available for typing when Wootility disables ordinary keyboard input; musical mapping editors still pause output.

## Play Visual Pianos

1. Open **Play** and keep the **Visual Pianos · 88 keys** profile selected.
2. For a MIDI keyboard, choose **MIDI Controller** and select a device if several are present. For Wooting, choose **Analog Keyboard**, install the [Wooting Analog SDK 0.9.1](https://github.com/WootingKb/wooting-analog-sdk/blob/v0.9.1/docs/INSTALL.md) separately, and enable analog input.
3. Enable **MIDI → QWERTY**, then focus [Visual Pianos on Roblox](https://www.roblox.com/games/5593470048/Visual-Pianos). Enable the game's corresponding 88-key and velocity controls if its current UI requires them.
4. Use **Panic** to stop transport and release owned keys, notes, and pedals. Output starts off at launch and after input disconnection; reconnecting never arms it.

The game preset adapts the MIT `miditoqwerty-rs` Piano Visualizations protocol: Shift for black notes, Ctrl for notes below C2/above C7, and Alt plus one of 32 keys for MIDI velocity. CC64 sends Space; CC66 sends `]`. In **Mapping → Profile**, **Velocity** controls Alt-key velocity output, **Sustain** controls CC64 pedal output, and **88 Keys** controls extended note output. These toggles are available in both mapping modes. With **88 Keys** off, QWERTY output is limited to C2–C7 (notes 36–96); the 88-key editor, saved mappings and MIDI output remain intact. Sustain retains its assigned key when switched off. Automated tests cover the protocol, and the user reported satisfactory operation before the 0.1.2 release. The game's current behavior and keyboard layout can affect compatibility; independent input-to-audio latency measurement remains outstanding.

**Analog setup:** physical Wooting typing is not suppressed. Configure a Wootility profile with the mapped digital keys disabled if you want only lazymidi's generated game input. Otherwise physical and generated presses can overlap. This does not affect other ordinary keyboards.

The supplied analog preset remains unchanged: HID → MIDI note, zero-based channels, threshold 0.5, velocity scale 1, and Left Shift transposition 1 semitone. The `Default copy` profile retains its 36 inverse bindings. A separate Visual Pianos profile adds game output for all notes A0–C8. Analog keyboards have fewer physical keys; use the editor and transposition to choose the range you play.

When analog input is enabled, **Play** shows Shift amount, Note trigger threshold and Velocity scale. Edit them as a draft, then **Apply analog settings**. The existing SDK connection stays active if its device/path/polling/input mode have not changed; generated output releases and requires re-enabling. Threshold is normalized depth (0–less than 1), velocity scale multiplies the depth-over-time estimate, and Shift amount is semitone transposition while Left Shift is held.

Wooting hardware is detected directly through the installed SDK when you enable analog input; the separate Wooting Analog MIDI application does not need to run. Its MIDI conversion model feeds the same internal mapper used by physical MIDI controllers. The Visual Pianos profile enables Alt-key velocity output by default.

## Edit mappings

In **Mapping**, select Analog → MIDI or MIDI → QWERTY. The 88-key piano spans MIDI notes 21–108. Click a note, choose a HID usage or click **Capture key**, and assign it. Capture uses physical `KeyboardEvent.code` only while that button has focus; it does not turn an ordinary keyboard into a musical input. Escape cancels. Analog assignment moves that physical key within the selected channel; the table also supports multiple bindings.

Output notes can have Shift and Ctrl modifiers. The game adapter pulses modifiers around each key-down, rather than holding them through the note. Profiles use drafts; **Apply profile** validates and saves all edits, releases output, and requires re-enabling it. Duplicate, import/export, restore, and MIDI learn are available. Imports never enable generated keys. The original default JSON is embedded in `crates/lazymidi-core/resources/presets/default-analog.json`.

Switching between Play and Mapping keeps Analog and MIDI → QWERTY enabled. Mapping, editing fields and dialogs temporarily pause generated keys; returning to Play resumes once all pause reasons clear. Converter text and number fields accept generated keys, including analog → MIDI → QWERTY typing with digital keys disabled in Wootility. Held notes must be released and pressed again after a pause. This does not interrupt ordinary MIDI routes or unload the SDK. A keyboard-send failure disables only QWERTY output while preserving working analog input.

On Windows, analog input uses a high-resolution timer while enabled. New settings default to 1000 Hz; saved polling preferences remain unchanged. Already-queued notes share an ordered keyboard batch without waiting to collect more notes, reducing redundant velocity commands within that batch. Timing diagnostics are opt-in; see [testing](docs/testing.md) for measurements and limitations.

Synthetic key protocols have a ceiling: multiple pitches can use the same physical key, and velocity-setting keys overlap with note keys. The adapter follows upstream retrigger behavior and keeps ownership until the final release, but a game's handling of those collisions determines audible polyphony. The app cannot independently encode arbitrary MIDI voices through a single keyboard key.

## Sequencer and routing

The Sequencer tab and its Play shortcut are currently hidden. Existing project/transport code is retained; it does not start playback or recording automatically.

Four tracks, 16 sixteenth-note steps, 20–300 BPM, per-note velocity and per-step gate. Default gate is 80%. Select an armed track and enable Record. Stopped recording replaces a step and advances; playback recording overdubs into the step active at the first note. Chords group after 30 ms of quiet, capped at 100 ms. This is step recording, not free-time performance recording.

Choose a MIDI destination or explicitly route a track to QWERTY. Generated playback additionally requires the Play toggle. Project files have the `.lazymidi` extension. Advanced routing supports both live inputs, channel filters and remapping. Internal playback → recorder cycles and duplicate routes are rejected. Without explicit recorder routes, recording captures the active live input into the armed track; explicit recorder routes replace that default tap for their source.

Destination routes belong to the active profile; project files store notes, gates, tempo and track properties. Select the matching profile when reopening a project.

## Develop and build

Install Node 22+ and stable Rust **1.91+**, plus the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). The lockfile includes newer transitive dependencies, so 1.91 is the tested toolchain. Run:

```sh
npm ci
npm run desktop
```

Frontend-only preview: `npm run dev` at `http://127.0.0.1:1420`. It never accesses native MIDI/SDK/keyboard output and clearly labels itself as a browser preview.

```sh
cargo test --workspace
cargo test -p lazymidi-core --no-default-features
cargo clippy --workspace --all-targets -- -D warnings
npm test
npm run build
python converter/test_environment.py
# Service tests need no model/GPU:
python -m pip install -r converter/requirements-test.txt
python converter/test_service.py
cargo fetch --locked
npm run notices
npm run bundle -- --bundles nsis
```

Use `--bundles deb` on Linux and `--bundles dmg` on macOS. The SDK loader is an optional core Cargo feature; the desktop build includes the loader, not the SDK. Linux/macOS need native build hosts. macOS window configuration keeps native traffic lights. Release signing/notarization require the distributor's certificates; no signing identity is supplied here.

To build experimental macOS installers from Windows, run the **macOS DMG** workflow in [GitHub Actions](https://github.com/LioK251/lazymidi/actions/workflows/macos-build.yml). It builds separate Apple Silicon (`aarch64`) and Intel (`x86_64`) DMGs for macOS 14+, tests the native core and packaged SDK-free startup, and uploads installers with SHA-256 checksums as workflow artifacts for 30 days. It does not publish or modify a release. These builds use ad-hoc signatures, are not notarized, and still need real-device MIDI, keyboard permission, Wooting and Roblox checks. Optional converter packs remain Windows-only; no Python/model runtime is included in the DMG.

## Persistence and recovery

Settings live in the platform application configuration directory returned by `directories::ProjectDirs` (`app / lazymidi / lazymidi`), not alongside the executable. Files use a version 1 envelope. Existing v1 profiles without game/modifier fields load with safe defaults. Profiles missing the new sustain/extended-key toggles preserve their previous output behavior. Legacy unversioned analog JSON can be imported. Future versions are rejected. JSON imports are limited to 1 MiB.

Writes use a same-directory temporary file, sync, atomic replacement, and one `.backup`. Invalid settings are preserved in timestamped `.invalid-*.json` files before a subsequent save replaces them. A valid backup is used on recovery; otherwise built-in defaults load with a warning. Failed settings saves leave the running settings unchanged. Project save only clears dirty state if the saved content is still current.

## Platform status

| Feature | Windows 11 x64 | Linux ALSA / X11 / Wayland | macOS Intel / Apple Silicon |
|---|---|---|---|
| Desktop build | Built locally | Native CI build; hardware QA pending | Experimental Apple Silicon/Intel DMGs; native startup verified, hardware QA pending |
| MIDI input/output | WinMM adapter | ALSA adapter | CoreMIDI adapter |
| QWERTY output | SendInput, target integrity restrictions | uinput, device permissions and target/compositor restrictions | CoreGraphics, Accessibility required |
| Wooting input | Optional installed compatible SDK | Optional SDK and HID permissions | Optional architecture-matching SDK |
| Sequencing/profiles | Tested core | Shared core; native OS QA outstanding | Shared core; native OS QA outstanding |
| App-created virtual output | Deferred | Implemented using midir | Implemented using midir |

Adapters being present does not imply hardware qualification. See [testing](docs/testing.md) and [architecture](docs/architecture.md) for current evidence and remaining manual gates. No cleanup guarantee is possible after force-kill, OS failure, or removed output hardware.

## Licensing

Original code is MIT. Adapted Wooting analog calculations, ArijanJ keyboard/game translations, Multi-Transpose behavior and mp3converter components retain their notices in `THIRD_PARTY_NOTICES` and the bundled license files. The old Wooting application host is not copied. No GPL LoopMidi code, Qt runtime, Wooting SDK, Python/PyTorch model or FFmpeg binaries are bundled in the application release. The visualizer includes the LGPL FluidSynth component with its license, corresponding source archive and rebuild instructions. Dependency notices include full available license texts and source links for unmodified MPL components. Regenerate them from the lockfiles with `npm run notices` before packaging.
