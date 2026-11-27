use crate::commands::{App, Error};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static GEOMETRY_SAVE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    scale: Option<f64>,
    #[serde(default)]
    maximized: bool,
}
fn load_geometry(path: &Path) -> BTreeMap<String, Geometry> {
    lazymidi_core::config::read_json(path)
        .or_else(|_| lazymidi_core::config::read_json(&path.with_extension("backup")))
        .unwrap_or_default()
}
fn minimum_size(kind: &str) -> (f64, f64) {
    match kind {
        "monitor" => (260., 130.),
        "visualizer" => (900., 620.),
        _ => (320., 190.),
    }
}
fn restored_size(kind: &str, g: &Geometry, scale: f64, bounds: (u32, u32)) -> (u32, u32) {
    let ratio = g
        .scale
        .filter(|s| s.is_finite() && *s > 0.)
        .map_or(1., |saved| scale / saved);
    let minimum = minimum_size(kind);
    let min_width = (minimum.0 * scale).round() as u32;
    let min_height = (minimum.1 * scale).round() as u32;
    (
        ((g.width as f64 * ratio).round() as u32).clamp(min_width, bounds.0.max(min_width)),
        ((g.height as f64 * ratio).round() as u32).clamp(min_height, bounds.1.max(min_height)),
    )
}
fn geometry_path(app: &tauri::AppHandle) -> PathBuf {
    app.state::<App>()
        .runtime
        .settings_path
        .with_file_name("overlays.json")
}
fn valid_kind(kind: &str) -> Result<(), String> {
    if ["monitor", "sheet", "visualizer"].contains(&kind) {
        Ok(())
    } else {
        Err("Unknown overlay.".into())
    }
}

#[cfg(windows)]
fn reveal_video(path: &Path) -> std::io::Result<()> {
    use std::{ffi::OsString, os::windows::process::CommandExt, process::Command};

    let windows = std::env::var_os("SystemRoot").ok_or(std::io::ErrorKind::NotFound)?;
    let mut selection = OsString::from("/select,\"");
    selection.push(path);
    selection.push("\"");
    Command::new(PathBuf::from(windows).join("explorer.exe"))
        .raw_arg(selection)
        .spawn()?;
    Ok(())
}

#[cfg(windows)]
fn watch_video_downloads(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::{
        take_pwstr, DownloadStartingEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2_4, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED},
        StateChangedEventHandler,
    };
    use windows_core::{Interface, PWSTR};

    let app = window.app_handle().clone();
    window.with_webview(move |webview| {
        let starting = DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            // SAFETY: WebView2 invokes both handlers on the controller's UI thread.
            unsafe {
                let download = args.DownloadOperation()?;
                let mut uri = PWSTR::null();
                download.Uri(&mut uri)?;
                if !take_pwstr(uri).starts_with("blob:") {
                    return Ok(());
                }
                let mut mime = PWSTR::null();
                download.MimeType(&mut mime)?;
                if take_pwstr(mime).split(';').next() != Some("video/webm") {
                    return Ok(());
                }
                let app = app.clone();
                download.add_StateChanged(
                    &StateChangedEventHandler::create(Box::new(move |download, _| {
                        let Some(download) = download else {
                            return Ok(());
                        };
                        let mut state = Default::default();
                        download.State(&mut state)?;
                        if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                            let mut path = PWSTR::null();
                            download.ResultFilePath(&mut path)?;
                            let path = PathBuf::from(take_pwstr(path));
                            if !path.is_absolute()
                                || !path.is_file()
                                || reveal_video(&path).is_err()
                            {
                                let _ =
                                    app.emit_to("visualizer", "visualizer-video-reveal-error", ());
                            }
                        }
                        Ok(())
                    })),
                    &mut Default::default(),
                )
            }
        }));
        // SAFETY: with_webview runs on the controller's UI thread. Observe without changing the download destination or dialog.
        let result = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_4>())
                .and_then(|core| core.add_DownloadStarting(&starting, &mut Default::default()))
        };
        if let Err(error) = result {
            eprintln!("Could not watch Visualizer downloads: {error}");
        }
    })
}

#[tauri::command]
// WebView2 window creation deadlocks inside synchronous Windows commands.
pub async fn open_overlay(app: tauri::AppHandle, kind: String) -> Result<(), Error> {
    valid_kind(&kind)?;
    let settings = app.state::<App>().runtime.snapshot().settings;
    if !(if kind == "visualizer" {
        settings.show_converter || app.state::<App>().smoke_converter
    } else {
        settings.show_transposer || kind == "sheet" && settings.show_converter
    }) {
        return Err("Enable Transposer or Converter to view sheets."
            .to_string()
            .into());
    }
    if let Some(window) = app.get_webview_window(&kind) {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        if kind == "visualizer" || kind == "sheet" {
            window
                .emit(&format!("{kind}-visibility"), true)
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let saved = load_geometry(&geometry_path(&app));
    let minimum = minimum_size(&kind);
    let size = match kind.as_str() {
        "monitor" => minimum,
        "visualizer" => (1120., 760.),
        _ => (700., 500.),
    };
    let builder = WebviewWindowBuilder::new(
        &app,
        &kind,
        WebviewUrl::App(format!("index.html?overlay={kind}").into()),
    )
    .title(format!("lazymidi · {kind}"))
    .decorations(cfg!(target_os = "macos"))
    .inner_size(size.0, size.1)
    .min_inner_size(minimum.0, minimum.1)
    .always_on_top(kind != "visualizer")
    .transparent(kind == "sheet" && !cfg!(target_os = "macos"))
    .skip_taskbar(false)
    .focused(false)
    .focusable(kind != "monitor");
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if kind == "visualizer" {
        if let Err(error) = watch_video_downloads(&window) {
            eprintln!("Could not watch Visualizer downloads: {error}");
        }
    }
    if let Some(g) = saved.get(&kind) {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let monitors = window.available_monitors().map_err(|e| e.to_string())?;
        let bounds = (
            monitors
                .iter()
                .map(|m| m.size().width)
                .max()
                .unwrap_or(2400),
            monitors
                .iter()
                .map(|m| m.size().height)
                .max()
                .unwrap_or(1600),
        );
        let (width, height) = restored_size(&kind, g, scale, bounds);
        window
            .set_size(tauri::PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        if monitors.iter().any(|m| {
            let p = m.position();
            let s = m.size();
            g.x >= p.x
                && g.y >= p.y
                && g.x.saturating_add(120) <= p.x.saturating_add(s.width as i32)
                && g.y.saturating_add(80) <= p.y.saturating_add(s.height as i32)
        }) {
            window
                .set_position(tauri::PhysicalPosition::new(g.x, g.y))
                .map_err(|e| e.to_string())?;
        } else {
            window.center().map_err(|e| e.to_string())?;
        }
        if g.maximized && kind != "monitor" {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }
    save_geometry(&window.as_ref().window());
    Ok(())
}
pub fn save_geometry(window: &tauri::Window) {
    if !["monitor", "sheet", "visualizer"].contains(&window.label()) {
        return;
    }
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let scale = window.scale_factor().ok();
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
        if size.width == 0 || size.height == 0 {
            return;
        }
        let _guard = GEOMETRY_SAVE.lock().unwrap_or_else(|e| e.into_inner());
        let path = geometry_path(window.app_handle());
        let mut saved = load_geometry(&path);
        let mut geometry = if maximized {
            let Some(previous) = saved.get(window.label()) else {
                return;
            };
            previous.clone()
        } else {
            Geometry {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale,
                maximized: false,
            }
        };
        geometry.maximized = maximized;
        if saved.get(window.label()) == Some(&geometry) {
            return;
        }
        saved.insert(window.label().into(), geometry);
        let _ = lazymidi_core::config::atomic_save(&path, &saved);
    }
}
pub fn save_all(app: &tauri::AppHandle) {
    for name in ["monitor", "sheet", "visualizer"] {
        if let Some(window) = app.get_webview_window(name) {
            save_geometry(&window.as_ref().window());
        }
    }
}
#[tauri::command]
pub fn overlay_options(app: tauri::AppHandle, kind: String, top: bool) -> Result<(), Error> {
    valid_kind(&kind)?;
    let window = app
        .get_webview_window(&kind)
        .ok_or_else(|| "Overlay is closed.".to_string())?;
    window.set_always_on_top(top).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn overlay_sheet(
    app: tauri::AppHandle,
    path: Option<PathBuf>,
    text: Option<String>,
) -> Result<(), Error> {
    let content=tauri::async_runtime::spawn_blocking(move||->Result<serde_json::Value,String>{
        if let Some(path)=path {
            let metadata=std::fs::metadata(&path).map_err(|e|e.to_string())?;
            if metadata.len()>8*1024*1024 {return Err("Sheet exceeds 8 MiB.".into());}
            let bytes=std::fs::read(&path).map_err(|e|e.to_string())?;
            let mime=match path.extension().and_then(|e|e.to_str()).unwrap_or("").to_lowercase().as_str(){"png"=>Some("image/png"),"jpg"|"jpeg"=>Some("image/jpeg"),"webp"=>Some("image/webp"),"txt"=>None,_=>return Err("Choose a text, PNG, JPEG or WebP sheet.".into())};
            if let Some(mime)=mime {Ok(serde_json::json!({"image":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))}))}
            else {Ok(serde_json::json!({"text":String::from_utf8(bytes).map_err(|e|e.to_string())?,"sheets_filename":path.file_name().map(|name|name.to_string_lossy())}))}
        } else {let text=text.unwrap_or_default();if text.len()>512*1024{return Err("Sheet exceeds 512 KiB.".into());}Ok(serde_json::json!({"text":text}))}
    }).await.map_err(|e|e.to_string())??;
    let state = app.state::<App>();
    let mut stored = state
        .sheet
        .lock()
        .map_err(|_| "Sheet unavailable.".to_string())?;
    let revision = state.sheet_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut content = content;
    content["revision"] = revision.into();
    *stored = content.clone();
    app.emit("sheet-content", content)
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn get_sheet(app: tauri::State<App>) -> serde_json::Value {
    app.sheet.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn piano_export(sheet: &serde_json::Value, revision: u64) -> Result<(String, String), String> {
    if sheet["revision"].as_u64() != Some(revision) || sheet["mode"] != "piano" {
        return Err("Sheet changed. Export the current piano score.".into());
    }
    let piano = &sheet["piano"];
    let xml = piano["musicxml"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("No piano score to export.")?;
    let name = piano["midi_filename"]
        .as_str()
        .ok_or("Missing score filename.")?;
    let name = PathBuf::from(crate::converter::export_name(name)).with_extension("musicxml");
    Ok((
        name.file_name()
            .ok_or("Invalid score filename.")?
            .to_string_lossy()
            .into_owned(),
        xml.into(),
    ))
}

fn write_sheet_export(path: PathBuf, bytes: &[u8]) -> Result<bool, String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid export directory.")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(true)
}

fn qwerty_image_name(sheet: &serde_json::Value, revision: u64) -> Result<String, String> {
    if sheet["revision"].as_u64() != Some(revision)
        || sheet["mode"] == "piano"
        || !sheet["image"].is_null()
        || !sheet["text"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
    {
        return Err("Sheet changed. Export the current QWERTY sheet.".into());
    }
    let source = sheet["source"]["midi_filename"]
        .as_str()
        .or_else(|| sheet["sheets_filename"].as_str())
        .unwrap_or("sheet.txt");
    let exported = crate::converter::export_name(source);
    let stem = Path::new(&exported)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("sheet");
    if exported != source || stem.ends_with("_lazymidi") {
        Ok(format!("{stem}.png"))
    } else {
        Ok(format!("{stem}_lazymidi.png"))
    }
}

#[tauri::command]
pub async fn export_qwerty_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    expected_revision: u64,
    png: String,
) -> Result<bool, Error> {
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        use tauri_plugin_dialog::DialogExt;
        if window.label() != "sheet" {
            return Err("Open the QWERTY Sheet viewer to export an image.".into());
        }
        let name = {
            let state = app.state::<App>();
            let sheet = state.sheet.lock().map_err(|_| "Sheet unavailable.")?;
            qwerty_image_name(&sheet, expected_revision)?
        };
        const MAX_PNG: usize = 32 * 1024 * 1024;
        if png.len() > MAX_PNG.div_ceil(3) * 4 {
            return Err("The sheet PNG exceeds the 32 MiB export limit.".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png)
            .map_err(|_| "Invalid sheet image.")?;
        if bytes.len() > MAX_PNG || bytes.len() < 45 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Invalid sheet PNG.".into());
        }
        let Some(path) = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PNG image", &["png"])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        write_sheet_export(path.into_path().map_err(|e| e.to_string())?, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(Error::from)
}

#[tauri::command]
pub async fn export_piano_sheet(
    app: tauri::AppHandle,
    expected_revision: u64,
) -> Result<bool, Error> {
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        use tauri_plugin_dialog::DialogExt;
        let (name, xml) = {
            let state = app.state::<App>();
            let sheet = state.sheet.lock().map_err(|_| "Sheet unavailable.")?;
            piano_export(&sheet, expected_revision)?
        };
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("MusicXML score", &["musicxml"])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        write_sheet_export(path.into_path().map_err(|e| e.to_string())?, xml.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(Error::from)
}

#[tauri::command]
pub async fn generate_sheet(
    app: tauri::AppHandle,
    midi_filename: String,
    settings: serde_json::Value,
    expected_revision: Option<u64>,
    piano_options: Option<serde_json::Value>,
) -> Result<serde_json::Value, Error> {
    if piano_options.as_ref().is_some_and(|v| !v.is_object()) {
        return Err("Invalid piano options.".to_string().into());
    }
    let generation = {
        let state = app.state::<App>();
        let stored = state
            .sheet
            .lock()
            .map_err(|_| "Sheet unavailable.".to_string())?;
        if expected_revision.is_some_and(|r| stored["revision"].as_u64() != Some(r)) {
            return Err("Sheet changed. Retry using the current sheet."
                .to_string()
                .into());
        }
        state.sheet_generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    app.emit(
        "sheet-loading",
        serde_json::json!({"revision":generation,"working":true}),
    )
    .map_err(|e| e.to_string())?;
    let completed_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move||->Result<serde_json::Value,String>{
        let state=app.state::<App>();
        let mut converter=state.converter.lock().map_err(|_|"Converter unavailable.".to_string())?;
        // Superseded requests must not overwrite the shared exported sheet file either.
        if state.sheet_generation.load(Ordering::SeqCst)!=generation{return Err("Sheet request superseded.".into());}
        let content = if let Some(mut options) = piano_options {
            crate::converter::check_midi(&app, &midi_filename)?;
            options["midi_filename"] = midi_filename.clone().into();
            let mut result = converter.request(&app, "POST", "/api/piano-sheet", options)?;
            result["midi_filename"] = midi_filename.into();
            result["qwerty_settings"] = settings;
            serde_json::json!({"mode":"piano","piano":result,"revision":generation})
        } else {
            let result=converter.request(&app,"POST","/api/convert-to-sheets",serde_json::json!({"midi_filename":midi_filename,"settings":settings,"preview":true}))?;
            serde_json::json!({"mode":"qwerty","text":result["sheet_text"],"sheets_filename":result["sheets_filename"],"source":{"midi_filename":midi_filename,"settings":settings,"line_chord_map":result["line_chord_map"]},"revision":generation})
        };
        let mut stored=state.sheet.lock().map_err(|_|"Sheet unavailable.".to_string())?;
        if state.sheet_generation.load(Ordering::SeqCst)!=generation{return Err("Sheet request superseded.".into());}
        if content["mode"] == "qwerty" {
            crate::converter::save_sheet(&app,content["sheets_filename"].as_str().ok_or("Missing sheet ID")?,content["text"].as_str().ok_or("Missing sheet text")?)?;
        }
        *stored=content.clone();
        app.emit("sheet-content",&content).map_err(|e|e.to_string())?;
        Ok(content)
    }).await.map_err(|e|e.to_string()).and_then(|result|result);
    if completed_app
        .state::<App>()
        .sheet_generation
        .load(Ordering::SeqCst)
        == generation
    {
        let _ = completed_app.emit("sheet-loading", serde_json::json!({"revision":generation,"working":false,"error":result.as_ref().err()}));
    }
    result.map_err(Error::from)
}

#[tauri::command]
pub async fn open_visualizer(app: tauri::AppHandle, midi_filename: String) -> Result<(), Error> {
    // Reuse the service's scoped MIDI validation; no arbitrary file paths enter the window.
    let check_app = app.clone();
    let filename = midi_filename.clone();
    let settings =
        tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
            crate::converter::check_midi(&check_app, &filename)?;
            check_app
                .state::<App>()
                .converter
                .lock()
                .map_err(|_| "Converter unavailable.".to_string())?
                .request(&check_app, "GET", "/api/settings", serde_json::Value::Null)
        })
        .await
        .map_err(|e| e.to_string())??;
    let content = {
        let state = app.state::<App>();
        let mut value = state
            .visualizer
            .lock()
            .map_err(|_| "Visualizer unavailable.".to_string())?;
        let revision = value["revision"].as_u64().unwrap_or(0) + 1;
        *value = serde_json::json!({"midi_filename":midi_filename,"settings":settings,"revision":revision});
        value.clone()
    };
    open_overlay(app.clone(), "visualizer".into()).await?;
    app.emit_to("visualizer", "visualizer-content", content)
        .map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("visualizer") {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_visualizer(app: tauri::State<App>) -> serde_json::Value {
    app.visualizer
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qwerty_image_export_names_the_displayed_text_sheet() {
        let mut sheet =
            serde_json::json!({"revision":4,"text":"a b", "sheets_filename":"Practice.txt"});
        assert_eq!(
            qwerty_image_name(&sheet, 4).unwrap(),
            "Practice_lazymidi.png"
        );
        assert!(qwerty_image_name(&sheet, 3).is_err());
        sheet["source"]["midi_filename"] = "Song_transkun.mid".into();
        assert_eq!(qwerty_image_name(&sheet, 4).unwrap(), "Song_lazymidi.png");
        sheet["image"] = "data:image/png;base64,test".into();
        assert!(qwerty_image_name(&sheet, 4).is_err());
    }

    #[test]
    fn sheet_export_preserves_a_destination_on_write_failure() {
        let directory = tempfile::tempdir().unwrap();
        let image = directory.path().join("Sheet.png");
        assert!(write_sheet_export(image.clone(), b"sheet image").unwrap());
        let invalid = image.join("Other.png");
        assert!(write_sheet_export(invalid, b"replacement").is_err());
        assert_eq!(std::fs::read(image).unwrap(), b"sheet image");
    }

    #[test]
    fn piano_export_uses_the_displayed_revision_and_musicxml() {
        let mut sheet = serde_json::json!({"revision":7,"mode":"piano","piano":{
            "midi_filename":"A & B_transkun.mid", "musicxml":"<score-partwise/>"
        }});
        assert_eq!(
            piano_export(&sheet, 7).unwrap(),
            ("A & B_lazymidi.musicxml".into(), "<score-partwise/>".into())
        );
        assert!(piano_export(&sheet, 6).is_err());
        sheet["mode"] = "qwerty".into();
        assert!(piano_export(&sheet, 7).is_err());
        sheet["mode"] = "piano".into();
        sheet["piano"]["musicxml"] = "".into();
        assert!(piano_export(&sheet, 7).is_err());
    }

    #[test]
    fn geometry_restores_legacy_sizes_large_screens_and_changed_dpi() {
        let mut g: Geometry =
            serde_json::from_str(r#"{"x":10,"y":20,"width":2800,"height":1800}"#).unwrap();
        assert_eq!(restored_size("sheet", &g, 1., (3840, 2160)), (2800, 1800));
        assert_eq!(restored_size("sheet", &g, 1., (1920, 1080)), (1920, 1080));
        assert!(!g.maximized);
        g.width = 1000;
        g.height = 600;
        g.scale = Some(1.25);
        assert_eq!(restored_size("sheet", &g, 1.5, (3840, 2160)), (1200, 720));
        assert_eq!(restored_size("monitor", &g, 1.5, (3840, 2160)), (1200, 720));
        g.width = 0;
        g.height = 0;
        assert_eq!(restored_size("monitor", &g, 1.5, (3840, 2160)), (390, 195));
        assert_eq!(restored_size("sheet", &g, 1.5, (3840, 2160)), (480, 285));
    }

    #[test]
    fn geometry_roundtrips_and_recovers_from_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("overlays.json");
        let mut saved = BTreeMap::new();
        saved.insert(
            "sheet".into(),
            Geometry {
                x: 20,
                y: 30,
                width: 900,
                height: 620,
                scale: Some(1.25),
                maximized: true,
            },
        );
        lazymidi_core::config::atomic_save(&path, &saved).unwrap();
        lazymidi_core::config::atomic_save(&path, &saved).unwrap();
        std::fs::write(&path, "invalid").unwrap();
        assert_eq!(load_geometry(&path), saved);
    }
}
