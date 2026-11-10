# Optional modules

Discord presence, Transposer and Converter can be enabled independently in
Settings. Musical input runs independently of these modules.

## Discord

Settings → Discord Rich Presence and Show Get button default on. The application
ID is `1558322430781563022`; Get points to https://github.com/LioK251/lazymidi.
Enable activity sharing in Discord. Presence reports Ready or connected active
sources, never song names, media links, history or paths. Discord absence is a
status, not a musical-input error. The worker retries at five-second intervals.
The application picture is managed in Discord's Developer Portal; use
`src-tauri/icons/icon.png` (512 × 512). No Discord account credentials are stored.

## Transposer

The tab defaults visible, while transpose output starts Paused each launch.
Configure a sequence of whole numbers from −50 to +50 and assign the game's
transpose Up/Down keys. Those keys must differ from generated notes, pedals,
velocity commands and global shortcut keys. Global Next, Previous and
Pause/Resume bindings use Tauri shortcut syntax, for example `Ctrl+Shift+F9`.
Bindings are initially unassigned; registration conflicts appear as errors.

Game tracking starts automatically at 0, without a manual Sync control. Start the
game at transpose 0, then use the monitor or Pause/Resume shortcut. The compact
260 × 130 monitor keeps the values and centered Previous / Pause / Next
controls, without a scrollbar, status line or current-value editor. Opening or reopening the monitor automatically resumes when bindings are configured. Resume applies
the selected sequence entry before Next/Previous advance. Selecting a
sequence button only selects an editor position. Perform changes using global
shortcuts or Float monitor while the game is foreground. Next/Previous wrap,
and send only the difference from the tracked current value. This controls
the game; it does not transpose internal notes or change analog Shift Amount.

The keyboard worker delivers ordered down/up pairs without fixed waits, in batches
of up to eight pulses, servicing music and cancellation between batches. Windows
uses native batching. The requested target appears while delivery is pending;
confirmed progress is tracked separately. Cancelling, Panic or partial output failure pauses
transposition and marks tracking unknown. Reset the game transpose to 0 before
resuming; tracking then restarts from 0. OS delivery cannot prove that a game
accepted a command. Manual changes in-game cannot be detected; restart lazymidi
with the game at 0 to reset tracking.
Profile sequence/bindings survive duplication and import/export; armed state
and tracked current value do not.

Windows mock-output comparison (10 jobs of 20 pulses, debug build): fixed waits
took 602.601 ms median / 610.639 ms p95 to finish; bounded immediate pairs took
0.007 ms median / 0.154 ms p95. First-send median was 0.017 ms before and 0.002 ms
after. This isolates worker scheduling, not native delivery or Roblox reception.
The monitor's pending target and toolbar transfer were checked in a browser fixture;
live game timing and focus behavior still need a hardware check.

Editing fields, mapping and dialogs suspend performance shortcuts. Hiding the
tab unregisters them, disarms output and closes both overlays. Feature-only
settings changes preserve Analog and MIDI → QWERTY switches; musical mapping
Apply still intentionally disarms QWERTY output.

Float monitor is non-focusable. Float sheet accepts UTF-8 text, PNG, JPEG and
WebP, including generated converter sheets. Zoom, opacity, scrolling, on-top
controls are local to the viewer; mouse input stays enabled. Geometry is saved on close/exit and
recovered onto an available monitor. Windows non-activating behavior still
needs a live game check; macOS fullscreen and Linux compositor behavior vary.
Global shortcuts use the Windows/macOS/X11 backend; native Wayland is unsupported.

## Converter

Enable the Converter tab in Settings, then open **Convert → Runtime setup** and
choose **Install Converter**. The app downloads a private Python and installs
Transkun's piano model, music21 and the other required packages. FFmpeg is
included with the app. No terminal, compiler or separate Python setup is needed.

CPU is the default on Windows x64, Linux x64 and both Mac architectures.
Windows and Linux also offer NVIDIA GPU setup. Apple GPU processing is enabled
only after a successful local model check. Allow 4 GB free disk space for CPU
or 12 GB for NVIDIA GPU setup. An internet connection is needed during setup;
conversion and notation then run locally.

Setup shows the current step, download progress, cancellation and retry. It
checks a short real conversion and Piano support before selecting the new
runtime. An unsuccessful or cancelled setup keeps the previous runtime, and
runtime changes are rejected during an active conversion. Download archives
and temporary build files are removed after setup.

**Check again** rechecks the selected runtime without a folder dialog.
**Update Converter** installs the current dependencies in a fresh private
runtime. The app release contains no Python/model packs or numbered downloads.

### Reuse an existing converter environment

Under **Advanced setup**, choose **Use existing converter environment** and
select its folder. Supported layouts include `.venv`, `.cuda-venv`, Windows
`Scripts/python.exe` and Unix `bin/python` or `bin/python3`. The check requires
64-bit Python 3.10+, the conversion dependencies, Transkun's model and FFmpeg.
Piano additionally needs music21; automatic setup installs version 9.7.1.

The check does not install or change packages in that environment. Existing
environments without music21 can still convert audio and make QWERTY sheets.
Keep the selected environment and FFmpeg in place. Importing an old library is
a separate action.

### Conversion and library

Use **Local file** for audio/video or **Media link** for supported YouTube,
TikTok and Discord links. One conversion runs at a time, with two CPU threads
when using CPU. Cancel stops its decoder and inference processes. Completed
files remain in the library.

The compute preference saves immediately and also applies to browser jobs.
A GPU that is unavailable falls back to CPU without erasing that preference.
A conversion error offers a CPU retry; it does not silently rerun the job.

**Import MIDI** opens an existing MIDI file. **Import history & MIDI folder**
copies an old converter library or a folder of MIDI files. Originals remain
untouched; name collisions keep both versions, and repeated imports skip
identical copies. Linked files and browser cookies are excluded.

Library pages contain up to 24 songs. Search has its own page position;
clearing it restores the browsing page. Deleting files clamps that page to the
remaining results. Stored filenames stay unchanged; displayed names hide the
legacy `_transkun` suffix, while exports use `_lazymidi`.

### Piano notation

Choose **Sheet** on a Library card, then **Float** if it opens inside Convert.
The floating viewer's **QWERTY** and **Piano** buttons switch formats in the same
window. Piano shows treble and bass staves, playback, seeking, zoom and a following
cursor. Manual scrolling turns Follow off. Closing, minimizing, replacing the
score or opening another player pauses the previous playback.

**Settings → Modules → Show Piano button** defaults on. Turn it off and apply
settings to hide Piano in Convert and the floating viewer. Library cards keep
the same compact Sheet, Export and × row either way. An already loaded score stays open.

Use **Tracks & rhythm** to select tracks, change the staff split or choose finer
rhythm detail. Named left/right tracks determine the staff; other tracks split
at C4 by default. Notation groups chords, simplifies short releases into staccato
notes and estimates a key when none was stored. For regular transcriptions with
a placeholder MIDI clock, it estimates the written rhythm and tempo as well.
Playback retains the selected tracks' original timing,
velocities and pedals. QWERTY retains Auto, Multi, Manual and Original transpose
modes, editable transpose headings and Send to Transposer.

Notation is automatic; freely timed performances and dense arrangements may
need editing in a notation program. Supported inputs are beat-based MIDI types
0 and 1, up to 8 MiB, 20,000 selected notes, 8,000 beats and 2,000 measures.
Source MIDI files remain unchanged.

### Visualizer and browser extension

Song previews open a reusable visualizer window with Basic synth, imported SF2
fonts, styles, backgrounds, hand assignment and MIDI/video export. Closing the
window stops playback and keeps its loaded font cached until the app exits.
Save appearance retains visual settings; Reset background preserves imported
files. Video export requires the window to remain visible.

Load `extension/` as an unpacked Chromium extension and keep Converter enabled.
It connects automatically. Page buttons appear only when the local service is
ready and return after reconnection. Reload the extension and refresh supported
pages after an update. See [extension setup](../extension/README.md).
Media-site changes or verification requirements can prevent downloads.

Data is stored in the platform's application data directory, separately from
the selected Python environment. The local service exposes approved operations
and scoped media paths. The browser extension has its own limited token and
cannot read library settings or history.

## Build and qualification

Run the **Runtime tools** workflow to prepare FFmpeg and the small ncls wheel
for each platform. It builds FFmpeg 8.1.3, OpenSSL 3.5.9 and LAME 3.100 from
pinned source archives with GPL and nonfree components disabled. The tools and
licenses go in `converter/runtime-tools/`; generated binaries stay out of Git.
The [matching source archives](https://lazymidi.vercel.app/third-party/) and
bundled build recipe allow rebuilding the tools.

`converter/runtime-setup.json` pins each upstream Python archive's URL, size
and SHA-256. Only a verified archive is extracted. `converter/install_runtime.py`
installs packages directly from PyPI and PyTorch into that private interpreter,
with package caching disabled and temporary files scoped to the installation.
It uses Python 3.11.18, music21 9.7.1, Transkun 2.0.1 and PyTorch 2.9.1. Intel Mac
uses PyTorch 2.2.2, the last supported Intel Mac wheel. CUDA uses the cu128 build.
Windows and Intel Mac need a compiled ncls wheel, which the tools workflow builds
so users do not need a compiler.

Linux and macOS packaging workflows take the **Runtime tools** run ID, install
through the actual in-app setup code, and check real conversion and Piano before
verifying the packaged application. To qualify the native installer locally:

```sh
cargo test -p lazymidi direct_runtime_installs_and_runs -- --ignored --nocapture
```

Set `LAZYMIDI_TEST_ENVIRONMENT_OUTPUT=target/native-runtime.json` to retain the
isolated environment for a packaged check. Set `LAZYMIDI_TEST_RUNTIME_VARIANT=cuda`
to qualify NVIDIA setup. The tests also cover checksum rejection, cancellation,
cleanup and preservation of the selected environment.

For a local packaged check with a validated environment:

```sh
python scripts/verify-native-modules.py path/to/lazymidi --environment target/native-runtime.json
```

The check uses isolated storage and keeps the SDK and generated musical output
off. `--midi path/to/song.mid` additionally tests a specific song without changing
its source. Further measurements and hardware limits are in [testing](testing.md).
