# lazymidi

A desktop app for playing virtual piano games with a Wooting analog keyboard or a MIDI controller, converting piano audio to MIDI, and reading piano or QWERTY sheets.

Website: [lazymidi.vercel.app](https://lazymidi.vercel.app/). Downloads: [latest release](https://github.com/LioK251/lazymidi/releases/latest). Windows x64 installer and portable ZIP, plus experimental Linux and macOS packages. Extract the whole portable ZIP and keep `_up_` beside `lazymidi.exe`. Windows builds are unsigned; Mac apps are not notarized. Install the Wooting SDK separately if you use analog input.

## Optional tools

- **Discord:** presence and the GitHub Get button default On and can be disabled separately in Settings. Presence shares connected input labels only, not songs, paths or conversion history. Discord being unavailable does not interrupt playing.
- **Transposer:** assign the game's Up/Down keys, enter a sequence, and Apply. Use the compact floating monitor or global shortcuts while the game is foreground. Tracking starts from an assumed game value of 0; start the game at 0. Manual in-game changes cannot be detected. Output starts Paused; opening the monitor or sending a sheet sequence resumes and applies the selected entry when bindings are configured. Interrupted delivery pauses tracking and requires resetting the game to 0 before resuming.
- **Converter:** enable its tab in Settings (Off by default), then open **Convert → Runtime setup → Install Converter**. The app installs Python, the piano model and notation packages automatically. No terminal is needed. CPU runtimes support Windows x64, Linux x64 and both Mac architectures. Windows/Linux also offer NVIDIA CUDA; Apple GPU processing is enabled when its local conversion check passes. Existing environments are under **Advanced setup**.
- **Sheets:** Library cards have one **Sheet** button. The floating viewer switches between **QWERTY** game keys and **Piano** notation, with playback, Follow, zoom and track selection. **Settings → Modules → Show Piano button** controls Piano actions in Convert and the viewer. QWERTY retains Auto/Multi/Manual/Original modes and Send to Transposer. See [sheet setup](docs/optional-modules.md#piano-notation).
- **Visualizer:** song cards open a separate player with Basic synth or imported `.sf2` fonts, styles, hand editing and exports. Closing it stops playback and keeps its loaded font cached until lazymidi exits.

An optional Chromium extension is included in the portable ZIP and as a separate ZIP. Extract it, load `extension/` as an unpacked extension, then keep lazymidi running with Converter enabled and a compatible Python environment selected. Connection is automatic. YouTube/TikTok have page buttons; Discord browser attachments have a **Convert with lazymidi** right-click action. MuseScore has a **Download MIDI to lazymidi** button using LibreScore's download authorization method. Page buttons stay hidden until converter health is confirmed and return automatically after reconnection. Replace/reload the extension and refresh supported pages to remove stale injected controls. Replace any older unpacked extension with the current copy. See [extension setup](extension/README.md); website verification or upstream changes can still block downloads.

The current visualizer uses Drawn (Sketchbook) keys that share pencil artwork and motion with falling notes. Muted hand notes and key highlights remain visible as faint ghosts while their audio is muted. Style and Keys are inside Style & appearance; Import .sf2 and the SoundFont dropdown are together beside playback controls. Imported backgrounds and appearance changes preview immediately; Save appearance retains them without resetting the player or its loaded font.

The converter remembers the chosen compute device, including for browser submissions. An unavailable GPU falls back to CPU without erasing the preference. Clearing Library search restores the page you were browsing. Converter fields accept generated keys when ordinary keyboard input is disabled in Wootility; musical mapping editors still pause output.

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
npm ci --ignore-scripts
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
python converter/test_piano_sheet.py
cargo fetch --locked
npm run notices
npm run bundle -- --bundles nsis
```

Prepare the platform tools with the **Runtime tools** workflow before packaging; see [build and qualification](docs/optional-modules.md#build-and-qualification). Use the Linux packages workflow for distributable `.deb` and AppImage builds; it includes the ALSA runtime dependency. Use `--bundles dmg` on macOS. The SDK loader is an optional core Cargo feature; the desktop build includes the loader, not the SDK. Linux/macOS need native build hosts. macOS window configuration keeps native traffic lights. Release signing/notarization require the distributor's certificates; no signing identity is supplied here.

The **macOS DMG** workflow in [GitHub Actions](https://github.com/LioK251/lazymidi/actions/workflows/macos-build.yml) builds separate Apple Silicon (`aarch64`) and Intel (`x86_64`) DMGs for macOS 14+. The apps use ad-hoc signatures and are not notarized. Real-device MIDI, keyboard permission, Wooting and Roblox checks remain hardware-dependent. Converter runtimes are downloaded separately from inside the app.

The **Linux packages** workflow in [GitHub Actions](https://github.com/LioK251/lazymidi/actions/workflows/linux-build.yml) builds x64 packages on Ubuntu 22.04 and checks the packaged app under X11. Install the `.deb` with `sudo apt install ./lazymidi_0.1.8_amd64.deb` to resolve dependencies. For AppImage, run `chmod +x lazymidi_0.1.8_amd64.AppImage` before opening it. Keyboard output needs configured `uinput` access; native Wayland global shortcuts are unavailable. Install Converter from Runtime setup when needed.

## Persistence and recovery

Settings live in the platform application configuration directory returned by `directories::ProjectDirs` (`app / lazymidi / lazymidi`), not alongside the executable. Files use a version 1 envelope. Existing v1 profiles without game/modifier fields load with safe defaults. Profiles missing the new sustain/extended-key toggles preserve their previous output behavior. Legacy unversioned analog JSON can be imported. Future versions are rejected. JSON imports are limited to 1 MiB.

Writes use a same-directory temporary file, sync, atomic replacement, and one `.backup`. Invalid settings are preserved in timestamped `.invalid-*.json` files before a subsequent save replaces them. A valid backup is used on recovery; otherwise built-in defaults load with a warning. Failed settings saves leave the running settings unchanged. Project save only clears dirty state if the saved content is still current.

## Platform status

| Feature | Windows 11 x64 | Linux ALSA / X11 / Wayland | macOS Intel / Apple Silicon |
|---|---|---|---|
| Desktop build | Built locally | Experimental x64 .deb/AppImage; packaged startup verified, hardware QA pending | Experimental Apple Silicon/Intel DMGs; native startup verified, hardware QA pending |
| MIDI input/output | WinMM adapter | ALSA adapter | CoreMIDI adapter |
| QWERTY output | SendInput, target integrity restrictions | uinput, device permissions and target/compositor restrictions | CoreGraphics, Accessibility required |
| Wooting input | Optional installed compatible SDK | Optional SDK and HID permissions | Optional architecture-matching SDK |
| Sequencing/profiles | Tested core | Shared core; native OS QA outstanding | Shared core; native OS QA outstanding |
| App-created virtual output | Deferred | Implemented using midir | Implemented using midir |

Adapters being present does not imply hardware qualification. See [testing](docs/testing.md) and [architecture](docs/architecture.md) for current evidence and remaining manual gates. No cleanup guarantee is possible after force-kill, OS failure, or removed output hardware.

## Licensing

Original code is MIT. Adapted Wooting analog calculations, ArijanJ keyboard/game translations, Multi-Transpose behavior and mp3converter components retain their notices in `THIRD_PARTY_NOTICES` and the bundled license files. The app downloads Python, PyTorch and the piano model only when Converter is installed. It bundles an LGPL FFmpeg build and a small ncls wheel so setup needs no compiler. Dependency licenses are retained; matching [FFmpeg/OpenSSL/LAME sources](https://lazymidi.vercel.app/third-party/) and the build recipe are available. The Wooting SDK is installed separately. The visualizer includes LGPL FluidSynth with its license, source archive and rebuild instructions. Regenerate application dependency notices with `npm run notices` before packaging.
