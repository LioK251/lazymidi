#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
mod converter;
mod overlays;
mod shortcuts;
use lazymidi_core::runtime::Runtime;
use tauri::Manager;

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let smoke_path = if arguments.next().is_some_and(|a| a == "--smoke-test") {
        arguments.next().map(std::path::PathBuf::from)
    } else {
        None
    };
    let runtime = Runtime::start().expect("Cannot create application worker threads");
    let smoke_flags: Vec<_> = arguments.collect();
    let smoke_overlays = smoke_path.is_some() && smoke_flags.iter().any(|a| a == "--overlays");
    let smoke_converter = smoke_path.is_some() && smoke_flags.iter().any(|a| a == "--converter");
    let converter = converter::Converter::default();
    let converter_control = converter.control.clone();
    let converter_cancel = converter.cancel.clone();
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("converter", |context, request, responder| {
            let handle = context.app_handle().clone();
            std::thread::spawn(move || responder.respond(converter::media(&handle, request)));
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(commands::App {
            runtime,
            operations: std::sync::Mutex::new(()),
            smoke_path,
            smoke_overlays,
            smoke_converter,
            sheet: std::sync::Mutex::new(serde_json::json!({"text":""})),
            sheet_generation: std::sync::atomic::AtomicU64::new(0),
            visualizer: std::sync::Mutex::new(serde_json::json!({"revision":0})),
            converter: std::sync::Mutex::new(converter),
            converter_control,
            converter_cancel,
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::native_smoke_ready,
            commands::app_command,
            commands::import_file,
            commands::export_file,
            commands::save_project,
            commands::load_project,
            commands::shutdown,
            overlays::open_overlay,
            overlays::overlay_options,
            overlays::overlay_sheet,
            overlays::get_sheet,
            overlays::generate_sheet,
            overlays::open_visualizer,
            overlays::get_visualizer,
            converter::converter_request,
            converter::converter_status,
            converter::converter_install,
            converter::converter_use_environment,
            converter::converter_stop,
            converter::converter_pick,
            converter::converter_export
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                let mut shortcuts = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(34));
                    let state = handle.state::<commands::App>();
                    if state.runtime.is_stopped() {
                        break;
                    }
                    let snapshot = state.runtime.snapshot();
                    if !snapshot.settings.show_converter && !state.smoke_converter {
                        state.converter_control.stop();
                        state
                            .converter_cancel
                            .store(true, std::sync::atomic::Ordering::Release);
                        if let Ok(mut converter) = state.converter.try_lock() {
                            converter.stop();
                        }
                    }
                    for (name, enabled) in [
                        ("monitor", snapshot.settings.show_transposer),
                        ("visualizer", snapshot.settings.show_converter),
                        (
                            "sheet",
                            snapshot.settings.show_transposer || snapshot.settings.show_converter,
                        ),
                    ] {
                        if !enabled {
                            if let Some(w) = handle.get_webview_window(name) {
                                if w.is_visible().unwrap_or(false) {
                                    let _ = w.close();
                                }
                            }
                        }
                    }
                    let desired = (
                        snapshot.settings.show_transposer,
                        snapshot.transpose.editing,
                        snapshot.settings.profile().transpose.clone(),
                    );
                    if shortcuts.as_ref() != Some(&desired) && state.smoke_path.is_none() {
                        if let Err(error) = crate::shortcuts::install(&handle, &snapshot) {
                            let _ = handle.emit("module-error", error);
                            let _ =
                                state
                                    .runtime
                                    .command(lazymidi_core::runtime::Command::Transpose {
                                        action: "pause".into(),
                                        value: None,
                                        index: None,
                                    });
                        }
                        shortcuts = Some(desired);
                    }
                    let _ = handle.emit("state", snapshot);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    overlays::save_geometry(window);
                    if window.label() == "visualizer" {
                        use tauri::Emitter;
                        api.prevent_close();
                        let _ = window.emit("visualizer-visibility", false);
                        let _ = window.hide();
                    }
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let handle = window.app_handle().clone();
                std::thread::spawn(move || {
                    let state = handle.state::<commands::App>();
                    let _ = state
                        .runtime
                        .command(lazymidi_core::runtime::Command::Panic);
                    let dirty = state.runtime.snapshot().project_dirty;
                    if dirty {
                        use tauri_plugin_dialog::{
                            DialogExt, MessageDialogButtons, MessageDialogKind,
                        };
                        if !handle
                            .dialog()
                            .message("The project has unsaved changes. Close without saving?")
                            .title("lazymidi")
                            .kind(MessageDialogKind::Warning)
                            .buttons(MessageDialogButtons::OkCancel)
                            .blocking_show()
                        {
                            return;
                        }
                    }
                    overlays::save_all(&handle);
                    state.converter_control.stop();
                    state
                        .converter_cancel
                        .store(true, std::sync::atomic::Ordering::Release);
                    state
                        .converter
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .stop();
                    state.runtime.stop();
                    handle.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Desktop runtime failed");
}
