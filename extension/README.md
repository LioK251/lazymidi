# lazymidi Converter extension

Optional Chrome/Edge extension. Requires Converter enabled and a compatible Python environment selected in lazymidi. It uses the app's saved compute-device preference, falling back to CPU when CUDA is unavailable.

1. Extract the extension ZIP. Open your browser's extensions page, enable developer mode and use **Load unpacked** to select the `extension` folder containing `manifest.json`.
2. Keep lazymidi running with Converter enabled in Settings and a compatible converter environment selected. The extension connects automatically; its popup shows connection and job status.
3. Controls are added to already-open supported tabs at installation. If your browser denies injection, reload the page once. Use the **Convert with lazymidi** button on YouTube/TikTok video pages.
4. In Discord's browser version, right-click an audio/video attachment or its download link and choose **Convert with lazymidi**. Open the extension popup for progress/errors. Message links are not attachments; expired attachment links need a fresh download link.
5. For MuseScore, use the page's **Import downloaded MIDI** button and choose a MIDI file you have already downloaded. This does not bypass MuseScore download permissions.

Return to lazymidi or its Convert tab to refresh the Library after a browser job completes. Conversion never starts piano output automatically. The runtime performs downloads and piano transcription; the extension only submits links or MIDI files. No separate CUDA installation is required when reusing your existing compatible environment.

No pairing code or endpoint entry is needed, including after restarting lazymidi. Remove the older unpacked extension before loading this version, to avoid duplicate copies. The extension can submit/import and check its own jobs; it cannot browse lazymidi's library, settings or history. Cookie files are not imported automatically. Site availability/authentication can affect downloads.

Adapted from [mp3converter](https://github.com/LioK251/mp3converter), revision `0c3b9e359f378f1e07537b63ca32c69e56491e0c`. MIT terms are included in `LICENSE`.
