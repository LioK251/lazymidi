# Verification and release qualification

Automated checks run locally on Windows 11 x64 with Rust 1.91.1 and Node 24.13.1. Core tests use mocked output actions; native hardware output is not automatically exercised.

Local results: 24 Rust checks and 5 UI tests pass, along with TypeScript, Clippy with warnings denied, production frontend build, and the 23 SDK-free core checks. The macOS Apple Silicon core passes cross-target `cargo check`; this is compilation evidence, not native linking or OS qualification. The Windows NSIS package builds successfully. A native WebView startup smoke test confirms frontend-to-Rust IPC and graceful shutdown, with QWERTY output and SDK initialization off. Run the built executable with `--smoke-test <absolute JSON receipt path>` to repeat this isolated startup check. It never enables keyboard output.

Browser layout checks confirm 88 piano keys and no horizontal page overflow at 1120×760 and 900×620; the current navigation contains Play, Mapping and Settings. Earlier sequencer UI checks exposed all 64 step buttons before the tab was hidden. Smaller-height panels scroll vertically. These browser checks do not qualify native snap, DPI or window behavior.

| Area | Automated coverage | Manual release gate |
|---|---|---|
| Defaults/profiles | Exact 36-pair analog JSON; desktop IPC channel-key parsing; inverse mapping; imports; validation; backups; invalid-file preservation; failed save | Clean install, export/import, app-data permissions, interrupted write |
| MIDI/ownership | Note On zero; invalid bytes/length; shared sources/keys/pedals; channel remapping; unmapped notes; Panic releases | Hardware chords, held-note unplug, sleep/resume, input identity ambiguity |
| Analog | Threshold, missing/invalid depth, zero elapsed time, Shift latch, multiple bindings, no held-note replay after reset | Wooting keyboard, SDK absent/incompatible, HID permissions, architecture match, 100/250/500 Hz calibration |
| Game output | All 88 upstream mappings; velocity quantization; Alt/Shift/Ctrl pulse order and release; sustain/sostenuto ownership | Visual Pianos on Roblox, game 88-key/velocity settings, US layout, repeated notes and shared-key chords |
| Sequencer | Chord window; sequential entry; gate releases; long-pause skip; source → recorder → both output types; 30-minute **simulated** absolute deadlines without drift | 30-minute actual playback, simultaneous live input, recording while playing, native synth note releases |
| UI | Startup-off output, unavailable browser output, profile draft/apply/restore, hidden sequencer navigation, conditional analog response controls, 88-key analog capture | Window snap/resize/DPI, 900×620 minimum, all focus states, denied permissions, accessibility, file dialogs |
| Queues/shutdown | Separate fault/control channel and generation logic; SDK-free runtime startup/shutdown | Native output saturation, device removal during activation, graceful exit, kill behavior |

Target measurements: external callback → native send p99 ≤5 ms; sequencer dispatch error p99 ≤3 ms idle and ≤10 ms under moderate load. These are unqualified targets, not measured results. Measure with native tracing and physical/loopback MIDI timestamps; frontend clocks are not suitable. Use at least 30 minutes of playback and record p50/p95/p99/max, failures, load and OS timer behavior.

Windows qualification needs non-elevated Roblox and lazymidi, then an elevated-target negative test. Linux needs Ubuntu 24.04 x64, ALSA, configured `/dev/uinput` access, X11 and a native Wayland target. Do not run the app as root. macOS needs Intel and Apple Silicon builds, Accessibility denial/grant tests, signing/notarization and a clean first launch. No global keyboard hook is installed, so global Input Monitoring is not requested.

The GitHub workflow builds/tests native Windows, Linux and macOS when pushed. It is configuration, not evidence that those remote jobs ran. Installed SDK hardware and live Roblox tests remain separate gates. Windows installers produced locally are unsigned unless a certificate is supplied. Linux/macOS release bundles require their native build hosts.
