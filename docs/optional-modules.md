# Optional modules

Version 0.1.4 adds Discord presence, a game-control transposer and
the optional converter. The supplied analog preset is unchanged.
The hidden sequencer stays hidden. Musical input runs independently of these modules.

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

Enable Converter tab in Settings; it defaults off. Opening Convert starts the
private service only after an optional runtime is installed. PyTorch and the
model load in a worker when a conversion begins. One job runs at a time, with
two CPU threads and background priority. Cancel kills tracked FFmpeg/inference
processes; app exit/disable kills the complete service process tree. Completed
results remain on disk. CPU fallback is an explicit user action.

### Reuse an existing converter environment

Use existing converter environment accepts the old converter folder or its
`.cuda-venv`/`.venv` folder. It checks 64-bit Python 3.10+, the required imports,
Transkun's packaged 2.0 model/config, FFmpeg/FFprobe and a small CUDA allocation.
It prefers `.cuda-venv` when choosing a converter root. An unavailable GPU leaves
CPU conversion available with an inline explanation. No pip installation,
library/model copy or driver installation occurs.

Validation runs in a cancellable background process group. The folder dialog
temporarily pauses generated output; validation resumes independently after the
dialog closes. Failed/cancelled checks retain the previous runtime, and changing
runtime is rejected while a conversion is active. The selection is saved atomically
in converter `active.json`; old string-valued pack selections remain compatible.
The selected Python launches lazymidi's private service with separate data and
bytecode writes disabled. Songs/settings are not automatically imported. Keep
the chosen environment, its base Python and FFmpeg in place; if moved or removed,
choose it again or install a pack. A separate runtime pack remains optional.

Windows x64 is currently qualified. The supplied old converter environment was
checked with Python 3.10.19/PyTorch 2.9.1+cu128; an actual generated-audio CUDA
conversion completed and produced valid MIDI without installing packages.

Development pack manifests record these measured Windows x64 sizes. Packs are
not included in 0.1.4; use an existing compatible environment. Developers can
generate local packs under `target/converter-packs/`:

| Pack | Download bytes | Installed bytes | Local install manifest |
| --- | ---: | ---: | --- |
| CPU | 511,745,132 | 1,262,559,818 | `cpu.json` |
| NVIDIA CUDA 12.8 | 3,343,169,690 | 5,367,919,404 | `cuda.json` |

Use Install local pack and select the JSON beside its ZIP. Do not move the
manifest away from the archive. The installer displays sizes, verifies SHA256,
rejects traversal/links/duplicate Windows paths and excessive expanded size,
stages extraction, then atomically switches the active pack. Previous packs
remain available. Download buttons stay disabled until real release URLs are
published. CUDA downloads use four separately hashed parts below GitHub's
asset limit; the installer concatenates them and verifies the whole ZIP too.
Local installation uses the complete ZIP.

Convert contains local audio/video and supported YouTube, TikTok and Discord
links; Library contains MIDI import, search, history, deletion and export.
Sheets exposes VP formatting, quantization, automatic/multi/manual transpose,
line-based manual points, export and floating viewing. Visualizer retains
hand correction/filtering/MIDI exports, basic synth, user SF2s, six visual
styles, imported image/video backgrounds, effects and WebM video rendering.
The Library uses song cards with artwork where available and a piano preview
fallback. The separate visualizer window offers six clickable style previews;
selecting a style updates the player. Save appearance to retain it. Other
appearance changes apply with Reload visualization.
Video rendering happens in real time and requires a visible visualizer;
hiding it pauses audio/animation and cancels rendering. No converter operation
enables game output or sends the converted song to Roblox.

The model transcribes piano, not arbitrary instrument separation. Media-site
availability/authentication can change. Cookie files are never imported
automatically. No bundled third-party songs or SoundFonts are included.

Data lives separately under the OS local application data directory,
`app.lazymidi.desktop/converter/data` on Windows. Copy existing converter data
accepts an AudioConverter/AudioConverterData folder. It copies supported MIDI,
sheets, history, settings and assets without following links or overwriting
collisions. The original folder remains untouched. Invalid JSON is retained,
settings/history have atomic saves and one backup. Runtime data and credentials
are never saved in musical profiles.

The service tries 127.0.0.1 ports 27653–27660, falling back to a random port
if all are occupied, and uses a random per-launch token
kept by Rust. The frontend receives approved JSON operations and scoped file
IDs. Custom media protocol reads only converter storage, with canonical path
and origin checks. The browser extension has a different, limited token.

Load the repository's `extension/` directory as an unpacked Chromium extension
if desired. With Converter enabled and a compatible environment selected,
connection is automatic. The worker discovers the local service, receives a
separate scoped token and reconnects after app restarts. Website origins cannot
use discovery: its custom header requires a CORS preflight, which is denied to
websites. The service prepares while the module is enabled; inference remains
lazy. Controls are added to open supported tabs and remain visible offline.
If all discovery ports are occupied, close obsolete lazymidi instances.
Extension access is
limited to submissions/import and its own jobs, not library/settings/history.
MuseScore integration imports an already downloaded MIDI chosen by the user.

## Build and qualification

`python scripts/build-converter-pack.py cpu` (or `cuda`) builds a versioned
embedded Python directory, pinned packages/model and FFmpeg. It requires a
trusted local FFmpeg distribution (`--ffmpeg C:/ffmpeg` by default).
Do not commit generated multi-gigabyte packs. `converter/packs.json` records
measured sizes and hashes; release URLs are deliberately null in this build.

The local Gyan FFmpeg build is GPLv3. Packs retain its license, exact FFmpeg
source archive and build configuration. Before public redistribution, obtain
and verify corresponding source/build material for every statically linked
external library, or replace it with an audited build. Runtime publication is
gated on that audit. Python/package/model notices are retained inside packs;
FluidSynth's LGPL source, license and rebuild instructions ship with the frontend.

Windows CPU and CUDA inference were exercised on this host (RTX 5080 for CUDA).
Linux/macOS/MPS packs are not supplied or qualified. Native MIDI/keyboard
permissions and the Wooting SDK remain the existing platform prerequisites.
This build is unsigned. Live Discord restart/clear, game acceptance of transpose
pulses, overlays across DPI/fullscreen/compositors, long conversions and online
site workflows remain manual qualification gates.

### Checks performed

- Rust workspace and SDK-free tests, TypeScript build and 64 UI/renderer tests.
- Default settings/profile round trips, shortcut/output conflicts, sequence
  wrap/delta/repeated targets and partial-send recovery.
- Keyboard pulse completion/cancellation and existing stuck-key/navigation tests.
- Pack checksum/traversal/case-collision/cancellation and previous-active recovery.
- Actual CPU pack extraction into an isolated folder and import of Torch/Transkun.
- Private-service tests: authentication/origin/scope, MIDI→sheet, automatic
  extension scope, single-job cleanup, copy import and invalid-settings recovery.
- Real CPU and CUDA transcription of generated test audio and cancellation.
- Browser visualizer loading/playback/styles/hand controls and WebM export state.
- Simulated MIDI/analog input→writer p99 approximately 42–59 µs, versus the
  previous documented 33–61 µs range. This excludes hardware, native insertion,
  game/audio and sustained load; it is not a claim of improved audible latency.
- During a real CPU conversion, an eight-note burst through the actual engine,
  output queue and Windows SendInput measured batched MIDI p50/p99 4.09/7.02 ms
  and analog-source 4.60/6.81 ms. These calibration sends use harmless F24
  releases, not game notes. The previous documented batched p99 was about
  14 ms on a differently loaded session; this is not a controlled audible
  latency comparison. The short generated-audio CPU job completed in 16.28 s.

### Navigation and converter fixes preview

Floating windows are created through an asynchronous Tauri command. The old
synchronous Windows command reproducibly hung while creating WebView2; the
native regression now opens both windows and exits normally. The current
Transposer tab opens; Settings has a visible Apply settings action and an
Open Transposer shortcut. A hidden tab must be enabled and applied there.

Converter setup, source selection and next steps are separated from advanced
controls. Startup failures have a Retry action. Switching MIDI discards the
previous sheet/export and loads the new song in the retained player; late MIDI loads
cannot restart hidden animation. Initial sheet loading cannot overwrite a newer
floating-sheet update. Media reads and exports share canonical storage checks,
including a Windows junction-escape regression. Copy import retains artwork
without overwriting the source or existing files.

`scripts/verify-native-modules.ps1 -Executable target/release/lazymidi.exe -Converter`
exercises the actual packaged frontend, both overlay commands, private Python
service and scoped MIDI fetch. It uses isolated test storage and a junction to
the locally built CPU runtime; SDK and generated musical output remain off.
The ordinary startup smoke flag remains available without optional packs.
Pass `-EnvironmentManifest target/environment-preview/validated-environment.json`
to the native verifier to exercise an explicitly validated existing environment
instead of the local CPU pack. The ignored Rust environment check creates this
manifest when `LAZYMIDI_TEST_ENVIRONMENT_OUTPUT` is set, and also verifies process
cancellation. `converter/test_environment.py` covers missing dependencies/model/
FFmpeg and unavailable CUDA; the service tests cover safe runtime switching.

### Converter library and sheet preview

Convert separates local files from media links, with direct sheet/preview actions
when a job completes. Import MIDI and **Import history & MIDI folder** are visible
in Convert and Library. Choose the old converter installation, AudioConverterData,
its converted folder, or a standalone MIDI folder. Import copies MIDI, text sheets,
artwork, supported user assets and matching history without changing originals.
Library previews are paged in groups of 24; search covers the full library.
Name collisions keep both versions; repeat imports skip identical copies and
history entries. Existing lazymidi settings win. Invalid history is rejected before
copying, browser cookies are excluded, and linked files/folders are skipped.
Both legacy visualizer_backgrounds and visualizer-backgrounds are recognized.

Embedded and floating sheets share tempo colors, underlined Ctrl notes, comments,
transpose headings, zoom, centering and plain-text/transpose copying. Export and
Copy sheet preserve the original text. The floating viewer has **Stay on top**,
opacity controls and remains available with Converter enabled
when Transposer is hidden. Image sheets retain image zoom. Viewer controls do not
send musical input. Original tempo/color reference: local mp3converter
static/js/sheets-utils.js, SHA256
`a204938ca1ebde905e94522b1e75b981e2adcdfd363c93b9a6b0b531a13452dc`.

Regression checks cover colored/plain rendering without HTML execution, copy
content, floating window options, late sheet replies, library refresh, collision
and repeat imports, history ordering, UTF-8 BOM, malformed history, original-file
preservation, settings and legacy background paths. Windows release, native
service/overlays and layouts at 900×620 and 1120×760 are checked separately;
foreground behavior over Roblox fullscreen remains a manual qualification gate.

### Sheet transpose and tempo controls

Sheets exposes **Auto**, **Multi**, **Manual** and **Original** modes. Auto chooses
one shift for the song; Multi chooses shifts by beat-based regions; Manual edits
game transpose values at zero-based chord positions; Original preserves pitches.
The editor converts game values to the opposite signed pitch shifts stored by
mp3converter, so existing saved points retain their meaning. Legacy auto/multi
preferences still load when no explicit mode is saved.

**Show BPM & tempo changes** and **Show timing markers** work independently and
refresh an existing sheet, as do mode changes. BPM comes from the MIDI tempo map;
there is no manual tempo override. Chord grouping is in milliseconds, line length
is in beats, and Multi uses the configured beat count for transpose regions.
Other formatting and manual point edits apply with Generate. Save settings keeps
these preferences across launches without altering source MIDI or game output.

### Generated sheets and visualizer windows

Sheet buttons in Convert, Library and conversion results generate immediately.
When the floating sheet is visible, these actions update it without switching
the main converter to Sheets. A minimized viewer is restored before generation,
also without switching sections. Otherwise, they open Sheets as before.
Enable **Always open Float** in Sheets to open the floating viewer first and
keep the current converter section on every Sheet action, even if the viewer
was closed. This preference saves immediately and defaults off.
Library search accepts the active profile's MIDI → QWERTY output, including
analog-generated notes, so it remains usable with normal typing disabled in
Wootility. Other editors and file dialogs still pause generated piano keys.
The main and floating views share source MIDI, effective settings, line/chord
positions and transient revisions. Both use the native generate_sheet command;
stale requests cannot publish or replace saved output. Failed regeneration keeps
the last valid sheet. Save settings explicitly persists the current sheet draft.

The floating toolbar places the unlabeled, accessible mode selector beside Send to
Transposer and hides the Tempo colors legend while retaining coloring. Sending
replaces the active profile sequence with displayed headings in order (including
signs and duplicates), selects the first entry and automatically resumes when the module is enabled and Up/Down bindings are configured. The first target is applied immediately.
It validates 1–512 whole values from −50 to +50 and preserves other settings.
Manual mode
edits game values directly in headings; Enter or blur commits, + adds a point
using its inherited value, and − beside an explicit heading removes the point.
Source-free text/image sheets cannot regenerate.
Click-through has been removed; Stay on top, opacity, colors and zoom remain.
The floating viewer groups opacity, Stay on top, colors, centering and zoom under
View. Open sheet, Copy sheet, Send to Transposer and the mode selector stay visible.
Editable headings and point controls keep the same line spacing as the notes.
The viewer saves zoom, opacity, Colors, Center and Stay on top immediately and
restores them after closing the window or restarting the app. These are viewer
preferences, independent of converter formatting and profile settings.
Floating-window position, normal size and maximized state save on close and
periodically while open. Restore adjusts sizes for DPI, recovers off-screen
positions and reads the geometry backup if its primary file is invalid.

Converter navigation is Convert, Library, Sheets. Each library card's Preview piano
image opens the same reusable native window. A new song loads
in the retained player without autoplay. The window retains styles, backgrounds, hand editing,
MIDI/video exports and SF2 selection/import. Appearance saves merge only appearance
fields, preserving sheet preferences. Geometry is recoverable, Stay on top defaults
Off, with the toggle after its label. Closing the visualizer or disabling Converter
hides its window and stops playback/rendering while preserving the player and loaded
SoundFont in memory. Reopening reuses that player without autoplay or reloading the
same font. Changing the selected font replaces it; exiting lazymidi frees the cache.
The converter remains optional and musical input is independent of these windows.

SoundFonts use bounded byte-range transfers rather than buffering a whole file in
the native webview response. Basic synth is selected when no valid saved font is
available. Saved font choices are retained; decoding/allocation errors remain in
the player instead of requiring an application restart.
