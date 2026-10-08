use lazymidi_core::{
    config,
    runtime::{Command, Runtime, Snapshot},
    sequencer::Project,
};
use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

pub struct App {
    pub runtime: Runtime,
    pub operations: Mutex<()>,
    pub smoke_path: Option<PathBuf>,
}
#[derive(Debug, Serialize)]
pub struct Error {
    code: &'static str,
    message: String,
}
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self {
            code: "operation_failed",
            message,
        }
    }
}
#[tauri::command]
pub fn get_state(app: State<App>) -> serde_json::Value {
    let mut value = serde_json::to_value(app.runtime.snapshot()).expect("Snapshot serializes");
    value["native_smoke"] = serde_json::Value::Bool(app.smoke_path.is_some());
    value
}
#[tauri::command]
pub async fn native_smoke_ready(app: tauri::AppHandle) -> Result<(), Error> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        let path = state
            .smoke_path
            .as_ref()
            .ok_or_else(|| "Native smoke mode is not enabled.".to_string())?;
        let snapshot = state.runtime.snapshot();
        if snapshot.qwerty_enabled || snapshot.analog_enabled || snapshot.sdk_version.is_some() {
            return Err("Optional output/SDK unexpectedly initialized on startup.".to_string());
        }
        config::atomic_save(
            path,
            &serde_json::json!({"native_frontend_ready":true,"snapshot":snapshot}),
        )?;
        state.runtime.stop();
        app.exit(0);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| Error::from(e.to_string()))?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn app_command(app: tauri::AppHandle, command: Command) -> Result<Snapshot, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = app.state::<App>();
        let _guard = app
            .operations
            .lock()
            .map_err(|_| "Command lock unavailable.".to_string())?;
        if let Command::Settings {
            settings,
            expected_revision,
        } = &command
        {
            settings.validate()?;
            let previous = app.runtime.snapshot();
            if *expected_revision != previous.revision {
                return Err("Preferences changed. Reload your draft before applying.".into());
            }
            // Disk failure must not apply a half-saved configuration in memory.
            config::atomic_save(&app.runtime.settings_path, settings)?;
            return match app.runtime.command(command) {
                Ok(snapshot) => Ok(snapshot),
                Err(error) => {
                    config::atomic_save(&app.runtime.settings_path, &previous.settings)
                        .map_err(|save| format!("{error}; rollback save failed: {save}"))?;
                    Err(error)
                }
            };
        }
        app.runtime.command(command)
    })
    .await
    .map_err(|e| Error::from(e.to_string()))?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn import_file(path: PathBuf) -> Result<lazymidi_core::config::Profile, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        let value: serde_json::Value = config::read_json(&path)?;
        config::import_profile(&value.to_string())
    })
    .await
    .map_err(|e| Error::from(e.to_string()))?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn export_file(app: tauri::AppHandle, path: PathBuf, kind: String) -> Result<(), Error> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = app.state::<App>();
        let snapshot = app.runtime.command(Command::CommitRecording)?;
        match kind.as_str() {
            "profile" => config::atomic_save(
                &path,
                &serde_json::json!({"version":1,"profile":snapshot.settings.profile()}),
            ),
            "analog" => config::atomic_save(&path, &snapshot.settings.profile().analog),
            "diagnostics" => config::atomic_save(&path, &snapshot),
            _ => Err("Unknown export type.".into()),
        }
    })
    .await
    .map_err(|e| Error::from(e.to_string()))?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn save_project(app: tauri::AppHandle, path: PathBuf) -> Result<Snapshot, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = app.state::<App>();
        let _guard = app
            .operations
            .lock()
            .map_err(|_| "Command lock unavailable.".to_string())?;
        let snapshot = app.runtime.command(Command::CommitRecording)?;
        snapshot.project.validate()?;
        config::atomic_save(&path, &snapshot.project)?;
        app.runtime.command(Command::ProjectSaved {
            project: snapshot.project,
        })
    })
    .await
    .map_err(|e| Error::from(e.to_string()))?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn load_project(app: tauri::AppHandle, path: PathBuf) -> Result<Snapshot, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = app.state::<App>();
        let _guard = app
            .operations
            .lock()
            .map_err(|_| "Command lock unavailable.".to_string())?;
        let project: Project = config::read_json(&path)?;
        project.validate()?;
        let snapshot = app.runtime.command(Command::Transport {
            action: "stop".into(),
        })?;
        app.runtime.command(Command::Project {
            project: project.clone(),
            expected_revision: snapshot.revision,
        })?;
        app.runtime.command(Command::ProjectSaved { project })
    })
    .await
    .map_err(|e| Error::from(e.to_string()))?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn shutdown(app: tauri::AppHandle) -> Result<(), Error> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        state.runtime.stop();
        app.exit(0);
    })
    .await
    .map_err(|e| Error::from(e.to_string()))?;
    Ok(())
}
