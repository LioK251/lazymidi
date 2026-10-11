# lazymidi Converter extension

Optional Chromium extension for lazymidi 0.1.4. Requires Converter enabled and a compatible runtime selected in lazymidi.

1. Extract the extension ZIP. Open your browser's extensions page, enable developer mode and use **Load unpacked** to select the `extension` folder containing `manifest.json`.
2. In lazymidi Convert, choose **Pair browser extension**. Enter its loopback endpoint and five-minute code in the extension popup.
3. Use supported YouTube/TikTok page controls to submit a conversion. For MuseScore, import a MIDI file you have already downloaded.

Pairing is single use and stored for the browser session. Re-pair after restarting lazymidi. The extension can submit/import and check its own jobs; it cannot browse lazymidi's library, settings or history. Cookie files are not imported automatically. Site availability/authentication can affect downloads.

Adapted from [mp3converter](https://github.com/LioK251/mp3converter), revision `0c3b9e359f378f1e07537b63ca32c69e56491e0c`. MIT terms are included in `LICENSE`.
