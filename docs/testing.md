# Verification and release qualification

## Version 0.2.0 local preview qualification — 2026-11-12

The Windows installer and portable ZIP are prepared for user testing. No 0.2.0
tag or GitHub release has been published. Release notes contain only app changes;
the published 0.1.9 notes were also shortened without changing its 13 assets.

197 frontend/extension tests, 22 notation tests and 21 service tests pass. The
service inference check remains skipped. TypeScript/Vite, optimized Windows
builds, NSIS integrity and portable ZIP integrity pass. Rust workspace tests,
SDK-free core tests, formatting and Clippy passed earlier in this implementation;
Rust code remains unchanged after those checks.

The real Last Christmas score passes eight width/zoom combinations in both
Standard and Detailed modes, including repeated resizing. Glimpse of Us and
Fantaisie-impromptu provide additional full-score checks. Across 24 screen/print
layouts, SVG ink checks detect no notehead/notehead, notehead/flag or
notehead/beam intersections. Cursor columns always move forward, and original
MIDI SHA-256 hashes stay unchanged. Regression tests cover simultaneous voices,
touching whole notes, resized beam slopes, stem direction on every chord note
and the existing tuplet timing workaround.

Four generated PDFs contain 7, 12, 11 and 20 A4 pages respectively. Every page has
content within its SVG page bounds; representative first, dense and last pages
were rasterized with Poppler and inspected. PDF preparation preserves the live
sheet, hides app controls for print and restores the document afterward. Titles
use the clean song name followed by `_lazymidi`; tests cover Unicode, invalid
filename characters, duplicate suffixes, cancellation and errors. The combined
Print / Save PDF action remains. The native Windows Save As suggestion remains
unverified because Computer Use rejected access to lazymidi.

The final portable executable passes native frontend, floating-window,
Converter and scoped-media checks, including rendering Last Christmas in both
notation modes. SDK initialization and generated keyboard output stay off.
All 47 portable files match their build/source inputs, and installer/ZIP hashes
are recorded in the local preview's `SHA256SUMS.txt`. User MIDI, environments,
settings, verification captures and website source are excluded from packages.

The private website update was deployed independently to lazymidi.vercel.app.
All 42 website checks pass, including future-release lookup and failure fallback.
Live verification confirms all six platform downloads resolve to the latest
stable release, currently 0.1.9. Website source remains ignored and untracked;
publishing a future stable release updates download links without redeployment.

On a MacBook Air M5 running macOS 27.2, the released 0.1.9 installer reproduced
Gatekeeper prompts and launch timeouts for both FFmpeg and FFprobe. The bundled
tools matched the release hashes and passed signature verification. Python's
macOS fast copy carried their download quarantine into every new runtime.
Copying only file contents fixes the launch while preserving the executable
bytes and signatures. A native regression fails with the original installer
and passes after the fix, checking both tools, executable permissions and
unchanged source metadata. All four installer tests pass on this Mac; Windows
passes the three portable installer checks and six environment tests, with
the Mac-specific metadata test skipped.

The fixed installer completed a fresh private Python 3.11.18/PyTorch 2.9.1 setup
on the M5. Actual transcription passes on both CPU and MPS, and Piano notation
is available. The validated runtime is selected in the installed app. The two
hash-verified bundled tools were also repaired locally for 0.1.9 setup retries;
the app signature still verifies and Gatekeeper remains enabled. The packaged
0.1.9 smoke check passes Converter, scoped assets and both notation modes, but
times out waiting for the animated Visualizer preview. This is separate from
the verified runtime setup and notation rendering.

## Version 0.1.9 release qualification — 2026-11-11

User feedback drove the toolbar and export fixes. On 2026-11-11 the user
explicitly approved GitHub publication with the final PDF filename correction.

186 frontend/extension tests, 59 Rust workspace tests, 45 SDK-free core tests,
21 notation tests, six environment tests, three installer-script tests and
21 private-service tests pass. Formatting, Clippy with warnings denied,
TypeScript/Vite production builds, NSIS packaging and archive integrity pass.
Six specialized Rust checks and one service inference check remain opt-in;
runtime installation and full model inference were not repeated.

The toolbar/export follow-up reran all 184 frontend/extension tests. Regressions
verify that both export actions wait for audio suspension, stop existing notes,
retain the playback position and recover from a pause failure. Title-bar tests
cover Piano/QWERTY switching, conversion suffix removal and opening a sheet
without a MIDI source. The earlier Rust/Python checks above cover unchanged code.

The final PDF filename fix sets the parent document's title while printing;
Chromium uses that title for the suggested filename even when printing an
iframe. Regression tests verify restoration after completion and print errors.
The real Edge Save as PDF flow opened a native Windows Save As dialog with
`Glimpse of Us - Joji (Piano Cover).pdf` prefilled. Cancelling restored the app
title to `lazymidi`. The test selected the PDF destination explicitly and sent
no job to the physical printer.

Real Edge checks confirm exclusive toolbar menus by mouse and keyboard, the
requested button order, removal of the score heading and explanation, and title
bar fit at 400 px. Both MusicXML and PDF exports ran during Glimpse playback with
Basic synth and the 380 MB SoundFont. AudioContext was suspended before export
entry, its clock stayed stopped during simulated blocking dialog work, and Play
resumed from the saved position after cancellation. PDF preparation still
generated seven pages with the clean title and lazymidi credit. These checks use
the real audio player and PDF renderer, with dialog completion simulated; they
do not replace native dialog acceptance. The SoundFont loaded in 46 bounded reads.

The original Glimpse Transkun file reproduced six missing graphical measures
after OSMD combined silent bars. Width calculation then threw
`minimumStaffEntriesWidth`, while the presence of partial SVG incorrectly
reported a successful load. Regressions cover missing measures, failed readiness
and recovery after redraw. The alternate Glimpse cover exposed an additional
Detailed-mode export failure: splitting a mixed straight/triplet chord left a
complex remainder. A failing minimal chord test now verifies exact tied
durations, offsets and pitches. Clef tests also verify returning from an octave
clef when the register drops.

Fresh scores from all three Glimpse files, Fantaisie-Impromptu, Chicago, Queen,
Kawaki, Abyss and Verity passed browser rendering in both Standard and Detailed
modes. Checks cover every score's duration columns and system Follow behavior,
manual scrolling, click-to-seek, widths from 420 to 1120 px and saved zoom from
1 to 3. Original MIDI hashes remain unchanged. These songs are local checks,
not distributed fixtures.

All nine Standard scores and Detailed Chicago passed print-layout checks for
page bounds and forward note positions. Nine actual PDFs have A4 page sizes and
no empty pages. Representative first/last pages were rasterized and inspected.
Tests include a mixed English/Japanese/Thai title and a 175-character unbroken
Japanese title, centered credit, wrapping, page margins, unchanged live score
layout and cleanup after print completion or preparation failure. MusicXML
export tests check exact score content, filename, current revision and mode.
MusicXML appearance in MuseScore remains a separate manual check.

The packaged Windows/WebView2 app passed real Glimpse generation in both detail
modes, shared-sheet revisions, scoped MIDI/background assets, retained viewers
and large SoundFont range checks. A zero-only Transposer sequence verifies
that opening does not arm, minimizing/closing pauses, and restoring/reopening
stays paused. It sends no keyboard pulses. The shortcut predicate and binding
validation have regression coverage; actual hotkey registration conflicts and
physical key dispatch remain for hands-on testing.
The refreshed final portable passed the same native checks with Glimpse.
Visibility polling also pauses minimized monitors on macOS, where minimizing
does not emit the resize event used by other platforms. Native smoke failures
write their error to the receipt and exit unsuccessfully instead of waiting
for the runner timeout.

Real Fantaisie SoundFont playback generated 95 non-silent PCM blocks with output
muted. Its 1,598 cursor samples had no clock rewinds or backward movement.
The 380 MB font used 46 bounded reads; three playing seeks and three score
replacements added none. Shared SoundFont selection with Visualizer passed.

The earlier interactive desktop helper could not connect to its native pipe or
browser host. The final PDF check instead used an isolated Edge profile and the
native dialog's filename control. Interactive installation, physical shortcuts,
audio listening, MIDI/analog devices and game input are not marked hand-tested
by the agent. Live media downloads have not been requalified for 0.1.9.
Linux/macOS packages use the native packaging workflows, which run their own
tests, in-app runtime setup and packaged-app checks before producing artifacts.
Windows builds are unsigned; Mac apps are ad-hoc signed and not notarized.

Packages, checksums and local evidence are kept under
`artifacts/0.1.9/`, outside disposable build directories. For isolated manual
testing, launch the executable
with `--smoke-test "C:\path\to\test-folder\session.json" --manual`, using an
absolute path in a writable test folder. This uses separate settings and
Converter data and keeps the normal UI and shortcuts active without running
the automatic smoke sequence. The regular `--smoke-test ... --overlays` flow
continues to disable global shortcut registration and exits after its checks.

## Version 0.1.8 release qualification — 2026-11-11

The Windows app passed user testing and was approved for release.
176 frontend/extension tests, 18 notation tests and 21 private-service tests
pass, as do the production TypeScript/Vite build, Windows NSIS packaging and
portable ZIP integrity checks. The opt-in transcription
test was not rerun. The preceding preview passed 57 Rust workspace tests,
formatting and Windows NSIS packaging; Rust and runtime installation code are
unchanged. Earlier runtime qualification also passed 45 SDK-free core tests,
six environment tests, three installer-script tests and Clippy.

Notation fixtures cover two staves, overlapping voices, ties, triplets, key and
meter changes, rests, one-hand pieces, track selection, malformed files and
unchanged playback. They also cover mixed straight/triplet rhythms, placeholder
tempo detection, staccato releases, accidental cancellation and bar-crossing ties.
“Abyss - Kaiju No. 8 OP | Piano | YUNGBLUD” now engraves as 59 measures at an
estimated 115 BPM with four flats. Extra voice-padding rests are hidden, and
the score has no unintended tuplets.
Rendered opening, verse, chorus and ending passages were inspected. The layout
now preserves each measure's minimum engraving width: compressed measures at
high zoom had reversed some note positions, causing 177/367 backward samples
in Standard/Detailed views at 700 px and 2× zoom. A 277,222-position sweep across
22 combinations of rhythm, width (420–1200 px) and zoom (0.5–3×) found none.
The cursor interpolates shared rhythmic columns on each audio-clock frame and stays
12 pixels wide at every zoom. Compact playback controls and marker styling were
inspected at 420, 700 and 1000 px. Regression checks cover tempo changes,
estimated rhythm, line breaks, resizing, zoom and replacement-song timing.
Play, seeking, Follow, manual scrolling, zoom and repeated score replacement
passed. Both modes retain identical playback MIDI; the original file's hash is
unchanged. The user's song is not a distributed fixture.

The current notation checks also use Queen – Bohemian Rhapsody (Piano Cover),
Fantaisie-Impromptu and It's Me It's Verity. Queen's bars 18–20 keep rising
accompaniment on the bass staff, align slightly separated chord attacks/releases
and hide redundant voice rests. Its irregular transcription retains the MIDI's
clock; no constant tempo is forced. Fantaisie's two unnamed tracks keep their
hands across C4, with independent triplets and sixteenths and the authored sharp
key signature. Bar-crossing rhythm splitting uses exact fractions to avoid a
rounding loop. Export preserves those ties without rebuilding oversized tuplets.
Original MIDI files and playback events remain unchanged.

Chicago_1 exposed another source of backward movement: OSMD lost the duration
of some isolated/hidden tuplets and interpolated between displaced voice glyphs.
The viewer now normalizes those durations without changing written flags or
beams, and follows cached tick columns. Standard and Detailed scores for Chicago,
Fantaisie, Kawaki wo Ameku, Queen, Abyss and Verity passed full-score duration and
column checks at 420–1120 px and 1–3× saved zoom. Chicago's opening bars 2–5 are
included. Fantaisie preserves its sixteenth rests, full-beat beams and genuine
triplets, with numbered eighth-note triplets in the left hand. Tests cover short
chromatic neighbours without changing playback pitches.

Click-to-seek passed on notes, rests and empty staff space in the four songs,
at 420–1120 px and 1–3× zoom, including scrolling and original-performance timing.
Both paused and playing states are preserved. A ledger-note regression catches
the nearest staff lookup selecting an adjacent beat instead of the clicked note.
Direct SVG note hits now use their own timestamp; Fantaisie bar 5 previously
selected the preceding rest in the compact layout. The old click tooltip is gone.
Follow was checked across all 52 Verity bars at 1120×760, 700×620 and 420×700,
including bar 33, oversized staves, manual scrolling, restoring Follow and
backward seeks. Current Follow checks cover every system in all twelve scores,
including Kawaki's high notes around bars 88–90 and a paused height-only resize.
System bounds include ledger notes and beams with 24 px of top padding; oversized
systems stay aligned at the top. Piano uses 80% of the saved zoom scale.

UI regressions cover the saved Piano-button preference in Convert and the
floating viewer, the Working indicator beside Piano, search-page restoration,
deletion, format switching, superseded loading events, tempo-aware seeking and
pausing before detach. Library checks cover 900–1360 px windows: Sheet, Export
and × share one aligned row, with four columns at 1120 px whether Piano is on
or off. Search and page position survive Settings changes. Sheet resizing and
zoom were checked at 420, 700 and 1000 px widths.
An imported 380 MB SoundFont generated non-silent PCM with output muted. Real
Abyss playback had no backward clock or marker movement. Initial loading used
46 bounded reads; three playing seeks, mode changes and three MIDI replacements
added none. Browser
checks also passed shared SoundFont selection between Piano and Visualizer.
The current Chicago and Fantaisie openings each passed a 16-second real-SoundFont
run with roughly 1,600 cursor samples, no backward movement and non-silent PCM.
Three playing seeks and three score replacements added no SoundFont reads.
Each native viewer retains its own audio engine and loaded font; this is shared
selection, not a single synthesizer instance spanning windows.
Opening another player stops the previous one in browser tests and the shared
player regression. Live WebView2 playback instrumentation was unavailable;
physical audio output and that native handoff remain for manual testing.

The current Windows/WebView2 build passes with full Chicago, Fantaisie and Kawaki notation,
including Standard/Detailed generation, using the existing environment and
isolated app storage. These checks cover shared sheet state, scoped
assets, floating-window minimize/restore, stale revisions and Sheet/Visualizer
reuse. SDK and generated keyboard output stay off.
The user's library and active runtime selection are unchanged.
Existing-environment and fresh CPU/NVIDIA installation checks passed during
the earlier runtime qualification, along with native large-SoundFont range checks.

Runtime setup downloads pinned Python 3.11.18 and installs music21 9.7.1,
Transkun 2.0.1 and the remaining dependencies directly from PyPI/PyTorch. The app
bundles FFmpeg and the small ncls wheel; no complete model runtime or numbered
parts are release assets. Native tests run the actual installer in isolated
storage, then check real CPU inference and Piano. Windows/Linux have CPU and
CUDA variants; both Mac architectures support CPU setup. GPU processing is
offered only after a successful local model check. Windows CUDA is checked on
an RTX 5080. A Requests dependency warning is prevented by pinning compatible
chardet and checking its import with warnings treated as errors.

Publication requires successful Linux and macOS package checks for this revision;
their preceding runtime qualification also passed. Release workflows install dependencies through the in-app
setup code before checking the packaged application. Debian/AppImage checks run
under X11; both Mac DMGs are mounted and their architecture, resources and
ad-hoc signatures checked. Each package must render normal/fine Piano and pass
the same floating-window, scoped-asset and retained-visualizer checks before its
artifact is uploaded. Native unit tests reject incorrect download sizes and
checksums, cancel the installation process tree, and preserve the prior runtime.
The Python installer tests verify private interpreter enforcement, official
package indexes, disabled package caching and temporary-file cleanup.

The website passes 24 desktop/mobile Chromium and WebKit checks, including
accessibility. Its source stays private and outside the repository and releases.

Physical audio/MIDI/analog devices, game input timing, Linux CUDA hardware and
Mac GPU hardware were not checked for this release. Interactive installer
operation and live media-site downloads were not rechecked. Windows builds are
unsigned; Mac apps are ad-hoc signed and not notarized. Linux/macOS remain
experimental until real-device input and permission checks are completed.

## Version 0.1.7 release qualification — 2026-10-14

148 frontend/extension checks, 56 Rust checks, 20 private-service checks and three
Python environment checks pass. Six specialized Rust checks and one inference
test remain opt-in. Production TypeScript/Vite builds pass.

Animated hands and Three.js have been removed. Legacy hands settings are ignored
on load and discarded on save; note hand correction, filtering and MIDI exports
remain. Renderer tests cover darker falling black notes with hand/track colors,
ghosted muted notes, drawn-key animation, pause/reduced motion and notices.

Filename regressions cover legacy `_transkun` suffixes, duplicate-number suffixes,
Unicode, unchanged ordinary names, MIDI/sheet export names and unchanged stored
file IDs/content. Native exports, browser MIDI exports and converter attachment
headers use `_lazymidi` in place of the legacy suffix.

Background tests upload a real PNG through the authenticated service, retain
both historical directory spellings and reject traversal. UI/bridge tests cover
immediate preview, reset, explicit persistence and foreign-message rejection.
Shared slider CSS covers WebKit and Firefox thumbs/tracks, focus and disabled
states in both app and embedded player. Scrollbars use shared dark styling.
The scrub regression reproduced 20 full canvas redraws during a burst of input
events and invalid fractional slider positions. Continuous precision and
frame-coalesced drawing fix both. Extension regressions reproduce an older
injected script recreating a visible offline button; default-hidden CSS and
health-confirmed visibility prevent the flash, including reused stylesheets.

Browser checks at 1120 × 760 and 900 × 620 confirm the hand-free player,
compact wrapping, cleaned song headings, darker black falling notes and shared
slider styling. Arrow-key checks confirm zoom, opacity and appearance sliders
retain keyboard control and visible focus. A real browser MIDI export produces
`Drawn piano_lazymidi_hands.mid` with a valid MIDI header. An eleven-second WebM
export decodes at 866 × 322 (4,834,632 bytes); physical audio quality was not tested.

The optimized Windows 0.1.7 executable passes isolated packaged frontend,
floating-window/minimize/restore, converter, stale-sheet revision, large SoundFont
range and visualizer reuse checks. Native background decoding requires a real
PNG uploaded through the authenticated converter service. SDK and generated keys
remain off. NSIS archive integrity passes; an interactive installation was not run.
Artifacts are staged under `target/releases/v0.1.7`.

Native GitHub Actions builds pass on Windows, Ubuntu, macOS Apple Silicon and
macOS Intel. Both DMGs pass filesystem/signature/architecture/resource checks
and SDK-free frontend startup from the mounted installer. Linux .deb and
AppImage packages pass version/resource checks and SDK-free frontend startup
under Xvfb. The .deb includes an explicit ALSA runtime dependency. Native
artifact checksums are verified before release staging.

Physical MIDI/analog hardware, keyboard permissions, Roblox/audio, live website
downloads and Linux/macOS desktop/compositor behavior remain unqualified for
this update. Converter runtime setup remains Windows x64 only. The earlier
preview evidence below is historical; its hands feature is absent from 0.1.7.

## Drawn visualizer local preview — 2026-10-14

All 130 frontend/extension tests pass, along with TypeScript/Vite, three Python
environment checks and 18 private-service checks (one optional inference test
skipped). Renderer regressions cover held drawn-key animation, pause/reduced
motion, darker black-key highlights, ghosted hands/notes/keys, physical release
versus sustain tails, crowded chords, scoped backgrounds and failed video loads.
Bridge/UI checks cover immediate appearance updates without reopening MIDI,
SoundFont import, canonical background persistence and foreign-message rejection.
Extension checks cover hiding page buttons offline and restoring them on reconnect
on YouTube, TikTok and MuseScore.

Browser checks with generated MIDI at 1120 × 760 and 900 × 620 confirm the compact
playback/SoundFont controls, single song heading, drawn hands, ghosted hand filters
and immediate imported-background preview. The browser video renderer completed
with a WebM success status; the resulting media was not independently decoded or
audited for audio quality.

The optimized Windows 0.1.6 executable and NSIS installer are staged in
`target/previews/drawn-visualizer-20261014`. Installer archive integrity and bundled
converter-source hashes pass. Packaged native frontend, floating-window,
minimize/restore, converter-service, sheet-revision and visualizer reuse checks
pass using isolated settings/data with drawn hands and an imported background.
SDK initialization and generated keyboard output remained off. User profiles,
the installed application and its existing converter environment were untouched.

This is an unpublished local preview; version metadata remains 0.1.6. Fingering
is estimated. Live website downloads, physical audio/game input and non-Windows
native behavior were not qualified for these changes. Closing the visualizer
still unloads its SoundFont; switching songs in the open window retains it.

## Version 0.1.6 library pagination — 2026-10-13

The replacement 0.1.6 also fixes floating-sheet startup ordering. A deterministic regression delivered the previous song at revision 8 before the startup reply containing the requested song at revision 9; the viewer incorrectly kept the previous song. Startup replies now participate in revision comparison, while older delayed events remain ignored. The regression and all 122 frontend tests pass. The earlier late-startup-reply protection remains covered.

The Sheet → return-focus regression failed in both normal and Always open Float modes before the fix: refreshing the MIDI file array reset the library to its first page. Pagination now resets for a changed search and clamps only when a page no longer exists. All 121 frontend tests pass, including preserving page two across sheet generation/focus, clamping after file removal, retaining that clamped page when files return and resetting a new search whose results still span multiple pages. Release-specific packaged/native results are recorded with the published build.

## Version 0.1.5 replacement release candidate — 2026-10-12

107 frontend/extension tests, 54 Rust checks, 45 SDK-free core checks and 18 private-service
tests pass; one optional inference test remains skipped. Formatting,
TypeScript/Vite and Clippy pass. The optimized Windows executable reports 0.1.5.
Packaged native frontend, minimize/restore, converter, generated-sheet and
visualizer checks pass with the existing environment and isolated data. The
NSIS archive integrity check passes. No SDK or generated keys were enabled.
Live website downloads, game/hardware typing, multi-monitor/DPI transitions and non-Windows native
qualification were not repeated for this release.

## Automatic browser connection — 2026-10-12

Before the fix, page-control regression tests failed on YouTube, TikTok and
MuseScore with no stored pairing. The empty-session connection check also
returned unavailable. Controls now remain visible, discover the converter on
loopback, reconnect after authentication expiry and inject into already-open
supported tabs. Reinjection retains one button and cleans page timers. The
popup shows connection/job state without an endpoint or pairing form.
The actual extension worker also discovered an isolated Python service and
imported a MIDI over loopback without stored credentials or manual pairing;
this used no model inference or user data.

Service checks cover real loopback HTTP discovery, website-origin rejection,
restricted extension scope and occupied-port fallback. Model inference remains
lazy; enabling Converter prepares only its service. Live browser installation
and authenticated website downloads still need manual qualification.

## Sheet viewer persistence and minimized restore — 2026-10-12

The reopen regression reproduced opacity and zoom returning to defaults. Viewer
preferences now persist immediately in WebView storage: zoom, opacity, Colors,
Center and Stay on top. Tests cover reopening, invalid fields, unavailable
storage and reapplying native Stay on top. Window geometry saves periodically
and on close, retains normal dimensions while maximized, skips minimized sizes
and recovers from its backup. Native helper tests cover legacy files, large
screens, DPI scaling, minimum sizes and corrupt-primary recovery.

Sheet actions also restore an existing minimized viewer before generation,
preserving the main section. Both visible and hidden minimized cases reproduced
the missing restore call before the fix. All 81 frontend tests, TypeScript/Vite,
54 Rust checks, 45 SDK-free core checks, formatting and Clippy pass. Native smoke
now uses isolated settings as well as converter data, and exercises minimizing
then restoring the sheet window. Live multi-monitor/DPI changes remain a manual
qualification gate. No version bump or publication.
The final optimized Windows executable and NSIS installer are in `target/latest`.
Packaged native frontend, minimize/restore, converter, sheet-generation and
visualizer checks pass with the existing Python environment and isolated data.
SDK initialization and generated keyboard output remain off during these checks.

## Generated-key typing in converter search — 2026-10-12

The focused converter Library search previously requested `pause: true`, stopping
the analog → MIDI → QWERTY path used for typing when Wootility digital outputs
were disabled. The App/Converter regression reproduced that request before the
fix. Search now opts out of the editor pause; mappings, other editors and dialogs
retain their existing behavior. Both player switches remain enabled. Native
hardware typing still requires manual verification with the user's mapping.
All 76 frontend tests and TypeScript/Vite checks pass. The fresh executable and
NSIS installer are in `target/latest`; native frontend, overlays, converter,
sheet generation and visualizer smoke checks pass with isolated data. No SDK or
keyboard injection was enabled during smoke verification. No publication.

## Always open Float local preview — 2026-10-12

75 frontend/visualizer tests pass. New cases cover the default-off preference,
immediate persistence without saving draft formatting, reopening, all Sheet entry
points, opening before generation, failed saves/windows and old sheet settings
preserving the current preference. TypeScript/Vite and 14 private-service tests
pass; the optional inference test remains skipped. Service validation rejects
non-boolean values and old settings without the field remain compatible.

Browser checks at 900 × 620 and 1120 × 760 confirm the toggle layout and Library
retention after opening Float. These checks mock native windows. The optimized
Windows executable in `target/always-float-preview` passes native frontend,
overlay, converter, sheet-generation and visualizer smoke checks with isolated
data and the existing Python environment. No SDK or game keys were enabled.

This initial preview retained all text-field pauses; the later generated-key
search fix above supersedes that behavior. This preview is unpublished;
live hardware/fullscreen behavior remains unqualified.

## Confirmed sheet-window polish for replacement 0.1.4

69 frontend/visualizer tests pass, including text/image appearance controls, keyboard dismissal and Sheet actions preserving Convert/Library while the floating viewer is visible. A hidden or closed viewer retains the original Sheets navigation. TypeScript/Vite checks pass.

Browser measurements at 620 × 430 and 320 × 320 show no horizontal overflow. At default zoom, editable headings and note rows all measure 33.30 px; at 1.1× zoom, all measure 36.63 px. Previously, manual headings measured 47.30 px and point-control rows 37 px. The View menu hides appearance controls until opened and preserves keyboard focus on Escape.

The fresh optimized local executable passes native frontend, overlay, converter-service, generated-sheet and visualizer checks with isolated test data. The user confirmed this candidate and requested republication as 0.1.4. All current app/package version metadata and the release notes use 0.1.4; 0.1.5 remains withdrawn. Earlier version labels below identify their original verification sessions.

## Version 0.1.5 parser fix

The floating-sheet Send to Transposer test reproduced the exact invalid-heading error with generated Multi-style headings (`Transpose by: -3 (-7)`). After accepting the optional signed-integer change annotation, it sends only the absolute targets, preserving order and duplicates. Parser regressions cover CRLF, signed targets, zero changes and malformed annotations; the existing backend tests retain length/range validation and automatic-resume coverage.

Local Windows checks: 65 frontend/visualizer tests and 52 Rust workspace tests passed. The patch does not change transpose delivery timing or musical processing. Live Roblox pulse reception remains a manual qualification.

The optimized 0.1.5 Windows executable passed native frontend, floating-window, converter-service, sheet-generation and visualizer smoke checks using isolated test data and the existing Python environment. SDK initialization and musical keyboard output stayed disabled during these checks.

## Version 0.1.4 preparation

Local Windows checks on 2026-10-12: 52 Rust workspace tests, 45 SDK-free core/integration tests and 64 frontend/visualizer tests passed. Formatting, Clippy with warnings denied, TypeScript/Vite build and clean `npm ci` passed. The npm audit reported no vulnerabilities at preparation time.

Python environment probes passed 3 tests; private converter service checks passed 14 tests, with the opt-in transcription test skipped. These checks use isolated temporary data and do not change profiles or the selected Python environment. CI now installs only the service test dependencies and runs both Python suites alongside the existing native matrix; remote Linux/macOS results are not yet available for this revision.

The 0.1.4 optimized Windows executable passed the native frontend/overlay/converter smoke check with an existing environment and isolated data. This includes the 260 × 130 monitor geometry, sheet generation/revision rejection, bounded SoundFont reads and visualizer hide/reopen. Monitor auto-resume and sheet-send auto-resume are covered by mocked IPC tests; live Roblox acceptance/focus has not been checked for this change.

Six specialized Rust tests remain opt-in (hardware/timing, optional runtime-pack installation and existing-environment qualification). Runtime packs are not release assets. Live Roblox/audio latency, Discord lifecycle, fullscreen/DPI behavior, external media workflows and non-Windows native qualification are still manual gates. Earlier timing and conversion evidence below describes its original test sessions, not a new 0.1.4 measurement.

## Analog velocity correction in 0.1.3

The reported quiet analog response reproduced with the selected profile's threshold 0.15 and velocity scale 0.61: a 0.04 → 0.24 press over 10 ms produced MIDI velocity 15 immediately, but velocity 1 after resting at depth 0.04 for 100 ms. The old calculator retained the initial touch timestamp. Wooting refreshes the anchor when depth stays within 0.01 of it, and when the key releases; resting time must not dilute the next strike. The corrected calculator measures speed before refreshing this anchor and truncates the MIDI byte as upstream does, retaining the 1–127 Note On guard and zero-time/missing-history protections. Stored profiles and the exact supplied default JSON are unchanged.

`cargo test -p lazymidi-core --test visual_pianos analog_velocity` covers resting and lightly moving depths, faster/slower strikes, velocity scale, partial-release retriggers, MIDI destination values and the corresponding game commands. A separate deterministic comparison compiled excerpts of Wooting's `Note::update_current_value` at `e4e98975f56eb95be2f60bcedb0454c898479e74`, substituting supplied monotonic timestamps for wall-clock reads. With identical samples at 100/250/500/1000 Hz, eight strike speeds and three resting durations, velocity mismatches fell from 72/96 before the correction to 0/96 after it, allowing lazymidi's intentional minimum velocity 1 where upstream emits 0. All 128 velocity-to-key translations also matched ArijanJ's `string_for_velocity` at `73e4d6bbcdbe154d90eaa9cd32a55ac16ddadb64`.

These comparisons verify calculation and translation, not perceived loudness in Roblox. Wooting upstream polls at 100 Hz, while lazymidi respects the saved polling rate. Different sampling of an accelerating physical strike can produce different values even with the same formula. No polling rate, trigger threshold or velocity scale was changed for this correction. Live same-hardware/game confirmation remains required.

After a renewed delay report, the running velocity test build's saved polling rate was 250 Hz (threshold 0.15, scale 0.61). A replay of the five recorded physical presses through the published and corrected calculators at 100/250/500/1000 Hz produced identical Note On timestamps at each rate; the velocity correction adds no sample of waiting. Fresh Windows timer checks measured median/p99 sample gaps of 4.114/4.192 ms at 250 Hz, 2.060/2.125 ms at 500 Hz, and 1.031/1.086 ms at 1000 Hz. The simulated input-to-writer test passed all twelve source/rate/velocity combinations, with p99 35–65 µs; one MIDI case reached a 4.55 ms session maximum. These checks exclude native game-key delivery and Roblox audio, so they do not establish the cause of the perceived delay. No saved settings or running processes were changed.

A second synthetic comparison used accelerating depth curves rather than constant-speed ramps. With threshold 0.15 and scale 0.61, one fast curve produced velocity 74 at 100 Hz versus 30 at 1000 Hz. Slower curves could produce the opposite difference. This is a sampling/trigger-time difference, not a velocity-to-QWERTY translation mismatch; the corrected implementation matched upstream when each received identical samples. A fair upstream feel comparison must first use the existing 100 Hz option and the same threshold/scale. No automatic rate change or gain boost was added. Game confirmation at equal rates and the user's preference between upstream cadence and 1000 Hz responsiveness remain pending.

Live Windows evidence: a read-only SDK 0.9.1 T-key capture collected 14,237 depth samples and five presses at threshold 0.15 / scale 0.71. Replaying those timestamps/depths produced old velocities `[16, 13, 11, 17, 6]`, corrected velocities `[16, 16, 15, 19, 14]`, and exactly the same corrected values through upstream's calculator. The probe emitted no keyboard or MIDI output. A separate temporary Windows observer accepted only injected events carrying lazymidi's `dwExtraInfo` tag `0x4c415a59`; its decoder self-check rejected physical/untagged events. It observed 386 tagged events from the running test app, including 47 Alt velocity commands and 47 matching note activations, with game levels 4/8/12/20/48. The observer was removed after 15 seconds; nothing was added to the application or installer.

The installed upstream configuration was also checked read-only: Wooting threshold 0.15 / scale 0.62, versus lazymidi threshold 0.15 / scale 0.71. Replaying the real trace through upstream at 100 Hz with its saved scale and ten frame phases produced different note values from 1000 Hz, confirming the sampling effect on physical input as well as synthetic curves. Native generation now demonstrably carries variable velocity, but these observations do not establish Roblox's audible response or the user's preferred feel. Both remain awaiting the requested game comparison. Saved settings were not altered by these probes.

## Automated qualification

Automated checks run locally on Windows 11 x64 with Rust 1.91.1 and Node 24.13.1. Core tests use mocked output actions; native hardware output is not automatically exercised.

Version 0.1.3 local source checks: 39 Rust tests, 38 SDK-free tests and 16 UI tests pass, along with formatting and Clippy with warnings denied. The two additional regression tests cover analog velocity after resting below threshold and strike speed/scale/retrigger behavior through MIDI and game commands. Earlier timing and physical trace evidence is recorded above. The latest perceived Roblox sound delay remains unresolved; release publication does not qualify game audio latency or change existing polling preferences.

Version 0.1.2 local results: 37 Rust checks and 16 UI tests pass, along with formatting, TypeScript, Clippy with warnings denied, production frontend build, and the 36 SDK-free core checks. Three performance tests ran explicitly outside the normal suite during latency diagnosis. The Windows NSIS build passed archive integrity verification; executable and installer report version 0.1.2. A native WebView startup smoke test confirms frontend-to-Rust IPC and graceful shutdown, with QWERTY output and SDK initialization off. Run the built executable with `--smoke-test <absolute JSON receipt path>` to repeat this startup check. It never enables keyboard output or changes settings. Earlier v0.1.1 qualification included a macOS Apple Silicon cross-target `cargo check`; that local cross-check was not repeated for this patch.

Browser layout checks confirm 88 piano keys and no horizontal page overflow at 1120×760 and 900×620; the current navigation contains Play, Mapping and Settings. Earlier sequencer UI checks exposed all 64 step buttons before the tab was hidden. Mapping and Profile panels have equal heights in both mapping modes, with the mapping rows scrolling inside the table. Smaller-height panels scroll vertically. These browser checks do not qualify native snap, DPI or window behavior.

| Area | Automated coverage | Manual release gate |
|---|---|---|
| Defaults/profiles | Exact 36-pair analog JSON; desktop IPC channel-key parsing; inverse mapping; imports; validation; backups; invalid-file preservation; failed save | Clean install, export/import, app-data permissions, interrupted write |
| MIDI/ownership | Note On zero; invalid bytes/length; shared sources/keys/pedals; channel remapping; unmapped notes; Panic releases | Hardware chords, held-note unplug, sleep/resume, input identity ambiguity |
| Analog | Threshold, missing/invalid depth, zero elapsed time, Shift latch, multiple bindings, no held-note replay after reset, old polling preferences and 1000 Hz persistence | Wooting keyboard, SDK absent/incompatible, HID permissions, architecture match, 100/250/500/1000 Hz calibration |
| Game output | All 88 upstream mappings; velocity quantization; Alt/Shift/Ctrl pulse order and release; sustain/sostenuto ownership; velocity/sustain/extended-key toggles for both sources; keyboard-only 61-note filtering | Visual Pianos on Roblox, game 88-key/velocity settings, US layout, repeated notes and shared-key chords |
| Sequencer | Chord window; sequential entry; gate releases; long-pause skip; source → recorder → both output types; 30-minute **simulated** absolute deadlines without drift | 30-minute actual playback, simultaneous live input, recording while playing, native synth note releases |
| UI | Startup-off output, unavailable browser output, profile draft/apply/restore, hidden sequencer navigation, conditional analog response controls, 88-key analog capture; profile output toggles, duplication and custom sustain bindings | Window snap/resize/DPI, 900×620 minimum, all focus states, denied permissions, accessibility, file dialogs |
| Queues/shutdown | Separate fault/control channel and generation logic; SDK-free runtime startup/shutdown | Native output saturation, device removal during activation, graceful exit, kill behavior |

Target measurements: external callback → native send p99 ≤5 ms; sequencer dispatch error p99 ≤3 ms idle and ≤10 ms under moderate load. These are unqualified targets, not measured results. Measure with native tracing and physical/loopback MIDI timestamps; frontend clocks are not suitable. Use at least 30 minutes of playback and record p50/p95/p99/max, failures, load and OS timer behavior.

Navigation regression tests cover returning to Play before the Mapping pause reply, rapid field focus/blur, out-of-order snapshots, overlapping dialogs, idempotent keyboard-only cleanup, held analog notes/pedals and partial-chord send failures. Mapping pauses generated keys while keeping Analog and QWERTY enabled; exiting resumes without replaying already-held notes. MIDI routes and recording continue. Profile Apply still disarms QWERTY deliberately.

Enable native timing capture for one session with `$env:LAZYMIDI_LATENCY = "1"` in PowerShell before launching the desktop executable. Use Settings → Export diagnostics while playing. Unset the variable afterwards with `Remove-Item Env:LAZYMIDI_LATENCY`. The snapshot's `latency` object reports SDK read duration, MIDI/analog input queues, keyboard output queue, native send duration (including chord expansion and individual key sends), and each input → completed keyboard send. Percentiles use the most recent 512 samples; count and max cover the session. Capture is off by default, uses bounded atomic buffers without hot-path logging/disk access, and sorts on the diagnostics caller. Native failures/cancelled chords are excluded from successful-send timings. Analog totals start at SDK read, excluding wait for the next sample and physical key travel; game/audio response is outside these measurements.

Run `cargo test -p lazymidi-core --release --lib simulated_input_to_keyboard_latency -- --ignored --nocapture` for the repeatable MIDI/analog queue-to-writer comparison, Velocity On/Off at 250/500/1000 Hz. This uses the real engine, bounded queues and output worker with a simulated writer; it emits no OS keys and does not load the SDK. The latest Windows development-host run measured p99 33–61 µs after sample/receipt across twelve cases. This does not include OS input or Roblox audio. New settings default to 1000 Hz; saved 100/250/500 Hz preferences remain valid and are respected. The exact analog preset and its 0.5 threshold remain unchanged.

The original Windows channel timeout, measured without changing the system timer resolution, woke analog polling every 15.24–15.27 ms at nominal 250/500 Hz (p99 16.05–16.28 ms). The analog worker now owns a Windows high-resolution waitable timer only while enabled; unsupported/failed timers fall back to channel timeouts. Commands are checked after each timer wake, with no spin loop or global timer-resolution change. `cargo test -p lazymidi-core --release --lib analog_polling_deadlines -- --ignored --nocapture` measured 4.13/2.07/1.03 ms median intervals at 250/500/1000 Hz and passed the regression assertion against the old 15 ms wake delay. The opt-in `analog_sample_interval` metric includes the actual worker cadence; `analog_to_send` still starts after sampling.

A separate SDK-enabled runtime calibration used the installed SDK 0.9.1 and connected Wooting 60HE+, with generated keyboard output disabled. Two seconds per rate measured median/p99 sample intervals of 4.12/4.36 ms (250 Hz), 2.07/2.22 ms (500 Hz), and 1.03/1.17 ms (1000 Hz), with zero dropped samples. The 1000 Hz session maximum was 4.58 ms. During concurrent compilation, an earlier 1000 Hz pass reached p99 4.61 ms; scheduling under load is not guaranteed. SDK reads were microseconds, so they did not explain the original delay. The SDK's tagged `src/plugin.rs` uses a separate blocking HID report reader and cached analog buffers; the 50 ms HID read timeout is a wait for a report, not a fixed delay added to every sample.

Native SendInput calibration used harmless F24 release events, avoiding held keys and game notes. Nine individual sends measured median/p99 1.96/2.74 ms, versus 1.90/2.82 ms for one batch, on this host. Single-note batching alone showed no meaningful latency benefit. The later queued-chord measurement below justified batching with redundant velocity removal; modifier and velocity ordering stays unchanged. This synthetic native measurement is not an audio measurement. No Roblox MCP client was connected for live game inspection, so perceived sound latency remains a hardware/game check.

A side-by-side release-library mapping-only comparison against v0.1.1 used 50,000 samples per Velocity setting. MIDI p99 was 0.9/1.1 µs before and 0.9/1.0 µs after; analog conversion p99 was 8.6/15.1 µs before and 7.4/12.9 µs after under the contemporaneous host load. This does not establish an end-to-end improvement: the conversion arithmetic remains far below a millisecond, and SDK/OS/game delivery still requires hardware measurements.

Windows qualification needs non-elevated Roblox and lazymidi, then an elevated-target negative test. Linux needs Ubuntu 24.04 x64, ALSA, configured `/dev/uinput` access, X11 and a native Wayland target. Do not run the app as root. macOS needs Intel and Apple Silicon builds, Accessibility denial/grant tests, signing/notarization and a clean first launch. No global keyboard hook is installed, so global Input Monitoring is not requested.

The GitHub workflow builds/tests native Windows, Linux and macOS when pushed. Prior main-branch runs passed on all four configured hosts; each release's notes identify its own verified run when complete. Installed SDK hardware and live Roblox tests remain separate gates. Windows installers produced locally are unsigned unless a certificate is supplied. Linux/macOS release bundles require their native build hosts.

The 2026-10-12 MuseScore extension update passes 118 frontend tests (31 extension checks). The existing button is tested with the supplied score ID 34743503, a current-bundle authorization suffix and the upstream legacy fallback. Checks cover single-click/no-picker behavior, signed CDN URL preservation, scoped import credentials, blocked hosts, HTML responses and both advertised and streamed download-size limits. An isolated real Flask service also accepted a valid generated MIDI through the actual extension worker's download/import path; the CDN response was simulated and user data was not accessed. Live testing of `https://musescore.com/user/120802646/scores/34743503` was blocked by Cloudflare verification in both direct HTTP and the available browser. Successful live download is not claimed. Native-player token interception remains excluded.

Experimental macOS 0.1.5 DMGs were built from revision `30375657bb394b2e1812742cd0b66359faa2871f` in [workflow run 38193422102](https://github.com/LioK251/lazymidi/actions/runs/38193422102). Both macOS 15 Apple Silicon and Intel runners passed frontend, Python service/environment, native Rust, SDK-free and Clippy checks. Tauri bundles the ad-hoc signed app; native `hdiutil` creates the compressed DMG with an Applications link, avoiding the failing Tauri disk-image helper. The workflow verifies image integrity, mounts it read-only, checks architecture, version 0.1.5, minimum macOS 14.0, app signature and converter resources, then launches the packaged executable and requires its native frontend receipt with Analog, QWERTY and SDK all off. Both mounted-app startup checks passed. The downloaded DMGs match their runner SHA-256 checksums. The four-platform native CI run [38193421899](https://github.com/LioK251/lazymidi/actions/runs/38193421899) also passed. No GitHub release assets were modified. Apple notarization, actual Mac MIDI/Wooting hardware, Accessibility permissions, Roblox, audio and optional converter environments remain unqualified.

Windows keyboard output now drains up to eight already-queued messages into one ordered SendInput batch. It does not wait to collect a chord. Consecutive notes with the same quantized velocity share one Alt command only inside that batch; the next send always starts with its own velocity command. Changed velocities, pedal/key actions, modifier keys as notes, and custom Alt/Meta bindings reset this reuse. Non-Windows output retains individual key sends. Native batches validate all keys before injection, and partial failures release every potentially pressed key before disabling QWERTY. Generation changes after insertion release the completed batch; stale messages cannot discard newer-generation notes. Tests cover these cases and preserve analog/MIDI routing during scoped cleanup.

An eight-note equal-velocity native event-count comparison measured 12.76 ms median / 14.79 ms p99 for 56 individual events, versus 4.24 / 6.06 ms for 21 ordered events. The integrated comparison is reproducible with `cargo test -p lazymidi-core --release --lib native_keyboard_burst_latency -- --ignored --nocapture`. It uses the real mapping engine and output queue, calling Windows SendInput with neutral F24 releases rather than game keys. MIDI-source burst completion measured median/p99 20.88/35.99 ms before and 6.92/14.32 ms with queued batching. Simulated normalized analog-source events measured 20.00/29.19 ms before and 7.18/13.89 ms after. The completion signal waits for the final note's Key Down, excluding its preliminary Key Up. Results vary with host load and batch availability; these numbers do not include physical input or audio. The user reported satisfactory operation and approved publication as 0.1.2. Independent Visual Pianos input-to-audio measurement remains outstanding.
