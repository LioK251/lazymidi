# lazymidi Converter extension

Optional Chrome/Edge extension. Requires Converter enabled and a compatible Python environment selected in lazymidi. It uses the app's saved compute-device preference, falling back to CPU when CUDA is unavailable.

1. Extract the extension ZIP. Open your browser's extensions page, enable developer mode and use **Load unpacked** to select the `extension` folder containing `manifest.json`.
2. Keep lazymidi running with Converter enabled in Settings and a compatible converter environment selected. The extension connects automatically; its popup shows connection and job status.
3. Controls are added to already-open supported tabs at installation. If your browser denies injection, reload the page once. Use the **Convert with lazymidi** button on YouTube/TikTok video pages.
4. In Discord's browser version, right-click an audio/video attachment or its download link and choose **Convert with lazymidi**. Open the extension popup for progress/errors. Message links are not attachments; expired attachment links need a fresh download link.
5. For MuseScore, click the existing page button, now labeled **Download MIDI to lazymidi**. It resolves the MIDI download with LibreScore's current-bundle MD5 authorization and legacy suffix fallback, downloads it, and imports it directly into the library. No file picker or extra button is added. MuseScore must expose a downloadable MIDI; site verification, unavailable scores and changed API behavior produce an error.

MuseScore integration adapts `src/file.ts` from [LibreScore/dl-librescore](https://github.com/LibreScore/dl-librescore/tree/5a9491f977f900943cb6f1ed3d703eb701bb03a6), MIT. The small, bundled MD5 helper is [blueimp JavaScript-MD5 2.19.0](https://github.com/blueimp/JavaScript-MD5/tree/v2.19.0), MIT. Full notices are in `vendor/`. JavaScript fetched from MuseScore is inspected as text to find its authorization suffix; it is never executed. The native-player token interception and the full LibreScore userscript/converter are not included.

Downloads are limited to 20 MiB and checked for a MIDI header before the converter validates them. Only HTTPS MuseScore hosts, `musescore-public.s3.amazonaws.com`, and the `/musescore/` path on `s3.ultimate-guitar.com` are accepted; redirects are rejected. CDN requests carry no browser cookies or local converter credentials.

Return to lazymidi or its Convert tab to refresh the Library after a browser job completes. Conversion never starts piano output automatically. The runtime performs downloads and piano transcription; the extension only submits links or MIDI files. No separate CUDA installation is required when reusing your existing compatible environment.

No pairing code or endpoint entry is needed, including after restarting lazymidi. Remove the older unpacked extension before loading this version, to avoid duplicate copies. The extension can submit/import and check its own jobs; it cannot browse lazymidi's library, settings or history. Cookie files are not imported automatically. Site availability/authentication can affect downloads.

Adapted from [mp3converter](https://github.com/LioK251/mp3converter), revision `0c3b9e359f378f1e07537b63ca32c69e56491e0c`. MIT terms are included in `LICENSE`.
