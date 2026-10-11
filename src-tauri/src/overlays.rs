use crate::commands::{App, Error};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::{collections::BTreeMap, path::PathBuf};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
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
        if kind == "visualizer" {
            window
                .emit("visualizer-visibility", true)
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let saved =
        lazymidi_core::config::read_json::<BTreeMap<String, Geometry>>(&geometry_path(&app))
            .unwrap_or_default();
    let builder = WebviewWindowBuilder::new(
        &app,
        &kind,
        WebviewUrl::App(format!("index.html?overlay={kind}").into()),
    )
    .title(format!("lazymidi · {kind}"))
    .decorations(false)
    .inner_size(
        if kind == "monitor" {
            260.
        } else if kind == "visualizer" {
            1120.
        } else {
            700.
        },
        if kind == "monitor" {
            130.
        } else if kind == "visualizer" {
            760.
        } else {
            500.
        },
    )
    .min_inner_size(
        if kind == "visualizer" {
            900.
        } else if kind == "monitor" {
            260.
        } else {
            320.
        },
        if kind == "visualizer" {
            620.
        } else if kind == "monitor" {
            130.
        } else {
            190.
        },
    )
    .always_on_top(kind != "visualizer")
    .transparent(kind == "sheet" && !cfg!(target_os = "macos"))
    .skip_taskbar(false)
    .focused(false)
    .focusable(kind != "monitor");
    let window = builder.build().map_err(|e| e.to_string())?;
    if let Some(g) = saved.get(&kind) {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        // Keep the monitor compact when restoring older, larger geometry.
        let (width, height) = if kind == "monitor" {
            ((260. * scale) as u32, (130. * scale) as u32)
        } else {
            (
                g.width
                    .clamp(if kind == "visualizer" { 900 } else { 320 }, 2400),
                g.height
                    .clamp(if kind == "visualizer" { 620 } else { 190 }, 1600),
            )
        };
        window
            .set_size(tauri::PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        let monitors = window.available_monitors().map_err(|e| e.to_string())?;
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
    }
    Ok(())
}
pub fn save_geometry(window: &tauri::Window) {
    if !["monitor", "sheet", "visualizer"].contains(&window.label()) {
        return;
    }
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
        let path = geometry_path(window.app_handle());
        let mut saved = lazymidi_core::config::read_json::<BTreeMap<String, Geometry>>(&path)
            .unwrap_or_default();
        saved.insert(
            window.label().into(),
            Geometry {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            },
        );
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
            else {Ok(serde_json::json!({"text":String::from_utf8(bytes).map_err(|e|e.to_string())?}))}
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

#[tauri::command]
pub async fn generate_sheet(
    app: tauri::AppHandle,
    midi_filename: String,
    settings: serde_json::Value,
    expected_revision: Option<u64>,
) -> Result<serde_json::Value, Error> {
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
    tauri::async_runtime::spawn_blocking(move||->Result<serde_json::Value,String>{
        let state=app.state::<App>();
        let mut converter=state.converter.lock().map_err(|_|"Converter unavailable.".to_string())?;
        // Superseded requests must not overwrite the shared exported sheet file either.
        if state.sheet_generation.load(Ordering::SeqCst)!=generation{return Err("Sheet request superseded.".into());}
        let result=converter.request(&app,"POST","/api/convert-to-sheets",serde_json::json!({"midi_filename":midi_filename,"settings":settings,"preview":true}))?;
        let content=serde_json::json!({"text":result["sheet_text"],"sheets_filename":result["sheets_filename"],"source":{"midi_filename":midi_filename,"settings":settings,"line_chord_map":result["line_chord_map"]},"revision":generation});
        let mut stored=state.sheet.lock().map_err(|_|"Sheet unavailable.".to_string())?;
        if state.sheet_generation.load(Ordering::SeqCst)!=generation{return Err("Sheet request superseded.".into());}
        crate::converter::save_sheet(&app,result["sheets_filename"].as_str().ok_or("Missing sheet ID")?,result["sheet_text"].as_str().ok_or("Missing sheet text")?)?;
        *stored=content.clone();
        app.emit("sheet-content",&content).map_err(|e|e.to_string())?;
        Ok(content)
    }).await.map_err(|e|e.to_string())?.map_err(Error::from)
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
