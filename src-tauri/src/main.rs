#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::App {
            runtime,
            operations: std::sync::Mutex::new(()),
            smoke_path,
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::native_smoke_ready,
            commands::app_command,
            commands::import_file,
            commands::export_file,
            commands::save_project,
            commands::load_project,
            commands::shutdown
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(34));
                    let state = handle.state::<commands::App>();
                    if state.runtime.is_stopped() {
                        break;
                    }
                    let _ = handle.emit("state", state.runtime.snapshot());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
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
                    state.runtime.stop();
                    handle.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Desktop runtime failed");
}
