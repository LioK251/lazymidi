use crate::commands::{App, Error};
use lazymidi_core::config;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pack {
    pub version: String,
    pub variant: String,
    pub platform: String,
    pub bytes: u64,
    pub installed_bytes: u64,
    pub sha256: String,
    pub file: String,
    pub url: Option<String>,
    #[serde(default)]
    pub parts: Vec<PackPart>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackPart {
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    pub url: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub installed: Option<String>,
    pub running: bool,
    pub installing: bool,
    pub validating: bool,
    pub environment: Option<ExistingEnvironment>,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExistingEnvironment {
    python: PathBuf,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    python_version: String,
    torch_version: String,
    cuda_available: bool,
    cuda_error: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum RuntimeSelection {
    Pack(String),
    Existing(ExistingEnvironment),
}
#[derive(Debug)]
struct RuntimePaths {
    python: PathBuf,
    tool_dirs: Vec<PathBuf>,
    variant: String,
    environment: Option<ExistingEnvironment>,
}
pub struct Converter {
    pub status: Arc<Mutex<Status>>,
    pub cancel: Arc<AtomicBool>,
    pub control: Arc<Control>,
    process: Option<Service>,
}
impl Default for Converter {
    fn default() -> Self {
        Self {
            status: Arc::new(Mutex::new(Status::default())),
            cancel: Arc::new(AtomicBool::new(false)),
            control: Arc::new(Control::default()),
            process: None,
        }
    }
}
#[derive(Default)]
pub struct Control {
    #[cfg(windows)]
    job: Mutex<Option<isize>>,
    #[cfg(unix)]
    pid: std::sync::atomic::AtomicU32,
    pub stopped: AtomicBool,
}
impl Control {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        #[cfg(windows)]
        if let Some(job) = self.job.lock().unwrap_or_else(|e| e.into_inner()).take() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(job as _);
            }
        }
        #[cfg(unix)]
        {
            let pid = self.pid.swap(0, Ordering::AcqRel);
            if pid != 0 {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
    }
}
struct Service {
    process: ManagedProcess,
    token: String,
    port: u16,
}
struct ManagedProcess {
    child: Child,
    control: Arc<Control>,
}
impl Drop for ManagedProcess {
    fn drop(&mut self) {
        self.control.stop();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn spawn_managed(command: &mut Command, control: Arc<Control>) -> Result<ManagedProcess, String> {
    control.stopped.store(false, Ordering::Release);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    unsafe {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cannot create converter process group.".into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
        {
            windows_sys::Win32::Foundation::CloseHandle(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cannot isolate converter process tree.".into());
        }
        *control.job.lock().unwrap_or_else(|e| e.into_inner()) = Some(job as isize);
    }
    #[cfg(unix)]
    control.pid.store(child.id(), Ordering::Release);
    Ok(ManagedProcess { child, control })
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = &app.state::<App>().smoke_path {
        return Ok(path.with_extension("converter"));
    }
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("converter"))
        .map_err(|e| e.to_string())
}
fn source(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../converter"))
    } else {
        app.path()
            .resource_dir()
            .map(|p| p.join("_up_/converter"))
            .map_err(|e| e.to_string())
    }
}
fn active_pack(directory: &Path) -> Result<PathBuf, String> {
    let name: String = config::read_json(&directory.join("active.json"))?;
    if !safe_name(&name) {
        return Err("Invalid active runtime.".into());
    }
    Ok(directory.join("runtimes").join(name))
}
fn active_runtime(directory: &Path) -> Result<RuntimePaths, String> {
    match config::read_json::<RuntimeSelection>(&directory.join("active.json"))? {
        RuntimeSelection::Pack(_) => {
            let pack = active_pack(directory)?;
            let metadata: serde_json::Value = config::read_json(&pack.join("pack.json"))?;
            let variant = metadata["variant"]
                .as_str()
                .filter(|s| ["cpu", "cuda"].contains(s))
                .ok_or("Invalid runtime metadata.")?
                .to_owned();
            Ok(RuntimePaths {
                python: pack.join("python/python.exe"),
                tool_dirs: vec![pack.join("ffmpeg")],
                variant,
                environment: None,
            })
        }
        RuntimeSelection::Existing(environment) => {
            for path in [
                &environment.python,
                &environment.ffmpeg,
                &environment.ffprobe,
            ] {
                if !path.is_absolute() || !path.is_file() {
                    return Err(format!("Existing environment file is missing: {}. Choose the environment again or install a runtime pack.", path.display()));
                }
            }
            Ok(RuntimePaths {
                python: environment.python.clone(),
                tool_dirs: vec![
                    environment.ffmpeg.parent().unwrap().to_owned(),
                    environment.ffprobe.parent().unwrap().to_owned(),
                ],
                variant: if environment.cuda_available {
                    "cuda"
                } else {
                    "cpu"
                }
                .into(),
                environment: Some(environment),
            })
        }
    }
}
fn environment_candidates(path: &Path) -> Result<Vec<PathBuf>, String> {
    if !path.is_absolute() {
        return Err("Choose an absolute environment path.".into());
    }
    let candidates = if path.is_file() {
        vec![path.to_owned()]
    } else {
        [
            ".cuda-venv/Scripts/python.exe",
            ".venv/Scripts/python.exe",
            "Scripts/python.exe",
            "python/python.exe",
            "python.exe",
        ]
        .iter()
        .map(|p| path.join(p))
        .collect()
    };
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|p| p.is_file() && p.file_name().is_some_and(|n| n == "python.exe"))
        .collect();
    if candidates.is_empty() {
        return Err("No Python environment found. Choose your converter folder or its .cuda-venv/.venv folder.".into());
    }
    Ok(candidates)
}
fn validate_environment(
    path: &Path,
    source: &Path,
    cancel: &AtomicBool,
) -> Result<ExistingEnvironment, String> {
    let mut errors = Vec::new();
    for python in environment_candidates(path)? {
        if cancel.load(Ordering::Acquire) {
            return Err("Environment check cancelled.".into());
        }
        let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        let stderr = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        let mut command = Command::new(&python);
        command
            .args(["-I", "-B", "-X", "utf8"])
            .arg(source.join("check_environment.py"))
            .current_dir(output.path().parent().unwrap())
            .env("OMP_NUM_THREADS", "2")
            .env("MKL_NUM_THREADS", "2")
            .env("OPENBLAS_NUM_THREADS", "2")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::null())
            .stdout(output.reopen().map_err(|e| e.to_string())?)
            .stderr(stderr.reopen().map_err(|e| e.to_string())?);
        let mut process = match spawn_managed(&mut command, Arc::new(Control::default())) {
            Ok(process) => process,
            Err(e) => {
                errors.push(format!("{}: {e}", python.display()));
                continue;
            }
        };
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err("Environment check cancelled.".into());
            }
            if let Some(exit) = process.child.try_wait().map_err(|e| e.to_string())? {
                if exit.success() {
                    let environment: ExistingEnvironment = config::read_json(output.path())?;
                    if environment.python != python {
                        return Err("Python reported an unexpected interpreter path.".into());
                    }
                    return Ok(environment);
                }
                let value =
                    config::read_json::<serde_json::Value>(output.path()).unwrap_or_default();
                errors.push(format!("{}: {}", python.display(), value["error"].as_str().unwrap_or("Python could not finish validation. Check that its base interpreter and dependencies still exist.")));
                break;
            }
            if Instant::now() > deadline {
                errors.push(format!(
                    "{}: environment check timed out.",
                    python.display()
                ));
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    Err(errors.join("\n"))
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':', '\0', '<', '>', '"', '|', '?', '*'])
        && !name.ends_with(['.', ' '])
        && ![
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(
            &name
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase()
                .as_str(),
        )
}
fn scoped_file(scope: &Path, name: &str) -> Result<PathBuf, String> {
    if !safe_name(name) {
        return Err("Invalid media ID.".into());
    }
    let scope = scope.canonicalize().map_err(|e| e.to_string())?;
    let file = scope.join(name).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(scope) {
        return Err("Media escaped converter storage.".into());
    }
    Ok(file)
}
pub(super) fn check_midi(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
    if !name.to_ascii_lowercase().ends_with(".mid") && !name.to_ascii_lowercase().ends_with(".midi")
    {
        return Err("Choose a MIDI file.".into());
    }
    scoped_file(&root(app)?.join("data/converted"), name)?;
    Ok(())
}
pub(super) fn save_sheet(app: &tauri::AppHandle, name: &str, text: &str) -> Result<(), String> {
    if !safe_name(name) || !name.ends_with("_sheets.txt") {
        return Err("Invalid sheet ID.".into());
    }
    let directory = root(app)?.join("data/converted");
    if directory.join(name).exists() {
        scoped_file(&directory, name)?;
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut temporary, text.as_bytes()).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist(directory.join(name))
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn approved(path: &str, method: &str) -> bool {
    let base = path.split('?').next().unwrap_or("");
    let exact = match method {
        "GET" => [
            "/api/health",
            "/api/history",
            "/api/settings",
            "/api/midi-files",
            "/api/sheet-content",
            "/api/soundfonts",
        ]
        .contains(&base),
        "POST" => [
            "/api/convert",
            "/api/history/delete",
            "/api/settings",
            "/api/convert-to-sheets",
            "/api/pairing",
            "/api/runtime-switch",
        ]
        .contains(&base),
        _ => false,
    };
    exact
        || ((method == "GET" && base.starts_with("/api/status/"))
            || (method == "POST" && base.starts_with("/api/stop/")))
            && uuid::Uuid::parse_str(base.rsplit('/').next().unwrap_or("")).is_ok()
}
impl Converter {
    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        self.control.stop();
        self.process = None;
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .running = false;
    }
    fn start(&mut self, app: &tauri::AppHandle) -> Result<(), String> {
        if let Some(service) = self.process.as_mut() {
            if service
                .process
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
            {
                return Ok(());
            }
            self.process = None;
        }
        if !app.state::<App>().smoke_converter
            && !app
                .state::<App>()
                .runtime
                .snapshot()
                .settings
                .show_converter
        {
            return Err("Enable Convert in Settings.".into());
        }
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return Err("Converter packs currently support Windows x64 only.".into());
        }
        self.control.stopped.store(false, Ordering::Release);
        let directory = root(app)?;
        let runtime = active_runtime(&directory).map_err(|e| {
            format!("Choose an existing converter environment or install a runtime pack. {e}")
        })?;
        let token = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
        let data = directory.join("data");
        fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let ready = directory.join(format!("ready-{}.json", uuid::Uuid::new_v4()));
        let mut command = Command::new(&runtime.python);
        command
            .args(["-I", "-B", "-X", "utf8"])
            .arg(source(app)?.join("service.py"))
            .current_dir(&data)
            .env("LAZYMIDI_CONVERTER_DATA", &data)
            .env("LAZYMIDI_CONVERTER_TOKEN", &token)
            .env("LAZYMIDI_COMPUTE_CAPABILITY", &runtime.variant)
            .env("LAZYMIDI_READY_FILE", &ready)
            .env("OMP_NUM_THREADS", "2")
            .env("MKL_NUM_THREADS", "2")
            .env("OPENBLAS_NUM_THREADS", "2")
            .env("PYTHONUTF8", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env(
                "PATH",
                std::env::join_paths(runtime.tool_dirs.iter().cloned().chain(
                    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
                ))
                .map_err(|e| e.to_string())?,
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let process = spawn_managed(&mut command, self.control.clone())?;
        let mut service = Service {
            process,
            token,
            port: 0,
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if self.control.stopped.load(Ordering::Acquire) {
                return Err("Converter startup cancelled.".into());
            }
            if let Ok(value) = config::read_json::<serde_json::Value>(&ready) {
                service.port = value["port"]
                    .as_u64()
                    .filter(|p| *p > 0 && *p <= 65535)
                    .ok_or("Invalid converter endpoint.")? as u16;
                break;
            }
            if service
                .process
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("Converter stopped during startup. Check the selected environment or reinstall its runtime.".into());
            }
            if Instant::now() > deadline {
                return Err("Converter startup timed out.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = fs::remove_file(&ready);
        self.process = Some(service);
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        status.running = true;
        status.error = None;
        status.installed = Some(runtime.variant);
        status.environment = runtime.environment;
        Ok(())
    }
    pub(super) fn request(
        &mut self,
        app: &tauri::AppHandle,
        method: &str,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if !approved(path, method) {
            return Err("Converter operation not allowed.".into());
        }
        self.start(app)?;
        let service = self.process.as_ref().unwrap();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let request = client
            .request(
                method.parse().map_err(|_| "Invalid method.")?,
                format!("http://127.0.0.1:{}{path}", service.port),
            )
            .header("X-Lazymidi-Token", &service.token);
        let response = if method == "POST" {
            request.json(&body)
        } else {
            request
        }
        .send()
        .map_err(|e| e.to_string())?;
        let success = response.status().is_success();
        let value: serde_json::Value = response.json().map_err(|e| e.to_string())?;
        if !success {
            return Err(value["error"]
                .as_str()
                .unwrap_or("Converter request failed.")
                .into());
        }
        Ok(value)
    }
}
#[tauri::command]
pub async fn converter_request(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<App>()
            .converter
            .lock()
            .map_err(|_| "Converter unavailable.".to_string())?
            .request(&app, &method, &path, body.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn converter_status(app: tauri::AppHandle) -> Result<serde_json::Value, Error> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let directory = root(&app)?;
        let guard = app.state::<App>();
        let converter = guard
            .converter
            .lock()
            .map_err(|_| "Converter unavailable.".to_string())?;
        let mut status = converter
            .status
            .lock()
            .map_err(|_| "Converter unavailable.".to_string())?
            .clone();
        match active_runtime(&directory) {
            Ok(runtime) => {
                status.installed = Some(runtime.variant);
                status.environment = runtime.environment;
            }
            Err(error) => {
                status.installed = None;
                status.environment = None;
                if directory.join("active.json").exists() {
                    status.error = Some(error);
                }
            }
        }
        let manifest: serde_json::Value = config::read_json(&source(&app)?.join("packs.json"))
            .unwrap_or(serde_json::json!({"packs":[]}));
        Ok(serde_json::json!({"status":status,"packs":manifest["packs"]}))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn converter_use_environment(app: tauri::AppHandle) -> Result<(), Error> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use tauri_plugin_dialog::DialogExt;
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return Err(
                "Existing converter environments currently support Windows x64 only.".into(),
            );
        }
        let state = app.state::<App>();
        if !state.runtime.snapshot().settings.show_converter {
            return Err("Enable Convert first.".into());
        }
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Choose your old converter or Python environment folder")
            .blocking_pick_folder()
        else {
            return Ok(());
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        let directory = root(&app)?;
        let probe_source = source(&app)?;
        let (cancel, status) = {
            let converter = state
                .converter
                .lock()
                .map_err(|_| "Converter unavailable.")?;
            let mut status = converter
                .status
                .lock()
                .map_err(|_| "Converter unavailable.")?;
            if status.installing || status.validating {
                return Err("A runtime setup is already running.".into());
            }
            status.validating = true;
            status.error = None;
            converter.cancel.store(false, Ordering::Release);
            (converter.cancel.clone(), converter.status.clone())
        };
        let handle = app.clone();
        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                let environment = validate_environment(&path, &probe_source, &cancel)?;
                let state = handle.state::<App>();
                let mut converter = state
                    .converter
                    .lock()
                    .map_err(|_| "Converter unavailable.")?;
                if cancel.load(Ordering::Acquire)
                    || !state.runtime.snapshot().settings.show_converter
                {
                    return Err("Environment check cancelled.".into());
                }
                let running = converter.process.is_some();
                if running {
                    converter.request(
                        &handle,
                        "POST",
                        "/api/runtime-switch",
                        serde_json::json!({"prepare":true}),
                    )?;
                }
                if let Err(error) = config::atomic_save(
                    &directory.join("active.json"),
                    &RuntimeSelection::Existing(environment.clone()),
                ) {
                    if running {
                        let _ = converter.request(
                            &handle,
                            "POST",
                            "/api/runtime-switch",
                            serde_json::json!({"prepare":false}),
                        );
                    }
                    return Err(error);
                }
                converter.stop();
                Ok(())
            })();
            let mut status = status.lock().unwrap_or_else(|e| e.into_inner());
            status.validating = false;
            status.error = result.err();
            let _ = handle.emit("converter-status", status.clone());
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(Error::from)
}
fn install_pack(
    directory: &Path,
    archive: &Path,
    pack: &Pack,
    cancel: &AtomicBool,
    status: &Mutex<Status>,
) -> Result<(), String> {
    if pack.platform != "windows-x86_64"
        || !["cpu", "cuda"].contains(&pack.variant.as_str())
        || !safe_name(&pack.version)
        || pack.bytes > 12 * 1024 * 1024 * 1024
        || pack.installed_bytes > 24 * 1024 * 1024 * 1024
    {
        return Err("Unsupported converter pack.".into());
    }
    let mut file = fs::File::open(archive).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != pack.bytes {
        return Err("Pack size mismatch.".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Installation cancelled.".into());
        }
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != pack.sha256 {
        return Err("Pack checksum mismatch.".into());
    }
    fs::create_dir_all(directory.join("runtimes")).map_err(|e| e.to_string())?;
    let staging = tempfile::tempdir_in(directory.join("runtimes")).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 100_000 {
        return Err("Too many runtime files.".into());
    }
    let mut total = 0u64;
    let mut names = std::collections::HashSet::new();
    for i in 0..zip.len() {
        if cancel.load(Ordering::Acquire) {
            return Err("Installation cancelled.".into());
        }
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("Unsafe archive path.")?;
        if entry.name().contains(['\\', ':'])
            || relative
                .components()
                .any(|c| !safe_name(&c.as_os_str().to_string_lossy()))
            || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || !names.insert(relative.to_string_lossy().to_lowercase())
        {
            return Err("Unsafe archive entry.".into());
        }
        total = total
            .checked_add(entry.size())
            .ok_or("Pack is too large.")?;
        if total > pack.installed_bytes {
            return Err("Installed size exceeds manifest.".into());
        }
        let path = staging.path().join(relative);
        if entry.is_dir() {
            fs::create_dir_all(path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(path).map_err(|e| e.to_string())?;
        let expected = entry.size();
        let mut written = 0u64;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err("Installation cancelled.".into());
            }
            let n = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > expected {
                return Err("Archive entry exceeds declared size.".into());
            }
            out.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        if written != expected {
            return Err("Incomplete runtime file.".into());
        }
    }
    let metadata: serde_json::Value = config::read_json(&staging.path().join("pack.json"))?;
    if metadata["variant"] != pack.variant
        || metadata["version"] != pack.version
        || !staging.path().join("python/python.exe").is_file()
        || !staging.path().join("ffmpeg/ffmpeg.exe").is_file()
    {
        return Err("Incomplete runtime pack.".into());
    }
    let name = format!("{}-{}-{}", pack.variant, pack.version, uuid::Uuid::new_v4());
    fs::rename(staging.path(), directory.join("runtimes").join(&name))
        .map_err(|e| e.to_string())?;
    config::atomic_save(&directory.join("active.json"), &name)?;
    status.lock().unwrap_or_else(|e| e.into_inner()).installed = Some(pack.variant.clone());
    Ok(())
}
#[tauri::command]
pub async fn converter_install(
    app: tauri::AppHandle,
    variant: String,
    local: bool,
) -> Result<(), Error> {
    use tauri_plugin_dialog::DialogExt;
    if !app
        .state::<App>()
        .runtime
        .snapshot()
        .settings
        .show_converter
    {
        return Err("Enable Convert first.".to_string().into());
    }
    let local_path = if local {
        app.dialog()
            .file()
            .add_filter("Pack manifest", &["json"])
            .blocking_pick_file()
            .map(|p| p.into_path())
            .transpose()
            .map_err(|e| e.to_string())?
    } else {
        None
    };
    if local && local_path.is_none() {
        return Ok(());
    }
    let (pack, local_archive) = if let Some(path) = local_path {
        let pack: Pack = config::read_json(&path)?;
        if !safe_name(&pack.file) {
            return Err("Invalid pack filename.".to_string().into());
        }
        let archive = path
            .parent()
            .ok_or("Missing directory.".to_string())?
            .join(&pack.file);
        (pack, Some(archive))
    } else {
        let manifest: serde_json::Value = config::read_json(&source(&app)?.join("packs.json"))?;
        let packs: Vec<Pack> =
            serde_json::from_value(manifest["packs"].clone()).map_err(|e| e.to_string())?;
        (
            packs
                .into_iter()
                .find(|p| p.variant == variant)
                .ok_or_else(|| {
                    "This runtime has not been published yet. Install a local pack.".to_string()
                })?,
            None,
        )
    };
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Runtime installation currently supports Windows x64 only."
            .to_string()
            .into());
    }
    if local {
        use tauri_plugin_dialog::MessageDialogButtons;
        if !app.dialog().message(format!("Install {} runtime?\nDownload: {:.1} MiB · Installed: {:.1} MiB\nSHA256: {}\nOnly install packs you trust.",pack.variant,pack.bytes as f64/1048576.,pack.installed_bytes as f64/1048576.,pack.sha256)).title("Converter runtime").buttons(MessageDialogButtons::OkCancel).blocking_show(){return Ok(());}
    }
    let (cancel, status) = {
        let state = app.state::<App>();
        let mut converter = state
            .converter
            .lock()
            .map_err(|_| "Converter unavailable.".to_string())?;
        let setup_busy = {
            let status = converter.status.lock().unwrap_or_else(|e| e.into_inner());
            status.installing || status.validating
        };
        if setup_busy {
            return Err("A runtime setup is already running.".to_string().into());
        }
        converter.stop();
        converter.cancel.store(false, Ordering::Release);
        let mut status = converter.status.lock().unwrap_or_else(|e| e.into_inner());
        status.installing = true;
        status.error = None;
        status.total = pack.bytes;
        status.received = 0;
        (converter.cancel.clone(), converter.status.clone())
    };
    let directory = root(&app)?;
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let mut download = None;
            let archive = if let Some(path) = local_archive {
                path
            } else {
                let mut temp =
                    tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
                let parts = if pack.parts.is_empty() {
                    vec![PackPart {
                        file: pack.file.clone(),
                        bytes: pack.bytes,
                        sha256: pack.sha256.clone(),
                        url: pack.url.clone(),
                    }]
                } else {
                    pack.parts.clone()
                };
                if parts.len() > 16
                    || parts.iter().try_fold(0u64, |n, p| n.checked_add(p.bytes))
                        != Some(pack.bytes)
                {
                    return Err("Invalid runtime download manifest.".into());
                }
                let client = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(30))
                    .build()
                    .map_err(|e| e.to_string())?;
                let mut received = 0;
                for part in parts {
                    let url = part.url.as_ref().ok_or("Runtime URL unavailable.")?;
                    if !safe_name(&part.file)
                        || !url
                            .starts_with("https://github.com/LioK251/lazymidi/releases/download/")
                    {
                        return Err("Untrusted runtime URL.".into());
                    }
                    let mut hash = Sha256::new();
                    let mut count = 0;
                    let mut buffer = vec![0; 1024 * 1024];
                    while count < part.bytes {
                        if cancel.load(Ordering::Acquire) {
                            return Err("Installation cancelled.".into());
                        }
                        let end = (count + 16 * 1024 * 1024 - 1).min(part.bytes - 1);
                        let mut response = client
                            .get(url)
                            .header("Range", format!("bytes={count}-{end}"))
                            .send()
                            .and_then(|r| r.error_for_status())
                            .map_err(|e| e.to_string())?;
                        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                            return Err("Download server must support ranged downloads.".into());
                        }
                        let expected = format!("bytes {count}-{end}/{}", part.bytes);
                        if response
                            .headers()
                            .get("Content-Range")
                            .and_then(|v| v.to_str().ok())
                            != Some(&expected)
                        {
                            return Err("Incorrect runtime download range.".into());
                        }
                        loop {
                            if cancel.load(Ordering::Acquire) {
                                return Err("Installation cancelled.".into());
                            }
                            let n = response.read(&mut buffer).map_err(|e| e.to_string())?;
                            if n == 0 {
                                break;
                            }
                            count += n as u64;
                            if count > end + 1 {
                                return Err("Download exceeds requested range.".into());
                            }
                            hash.update(&buffer[..n]);
                            temp.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                            status.lock().unwrap_or_else(|e| e.into_inner()).received =
                                received + count;
                        }
                        if count != end + 1 {
                            return Err("Incomplete runtime download.".into());
                        }
                    }
                    if format!("{:x}", hash.finalize()) != part.sha256 {
                        return Err("Download part checksum mismatch.".into());
                    }
                    received += part.bytes;
                }
                let path = temp.path().to_owned();
                download = Some(temp);
                path
            };
            install_pack(&directory, &archive, &pack, &cancel, &status)?;
            drop(download);
            Ok(())
        })();
        let mut state = status.lock().unwrap_or_else(|e| e.into_inner());
        state.installing = false;
        state.error = result.err();
        let _ = app.emit("converter-status", state.clone());
    });
    Ok(())
}
#[tauri::command]
pub async fn converter_stop(app: tauri::AppHandle) {
    let validating = app
        .state::<App>()
        .converter
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .validating;
    if validating {
        app.state::<App>()
            .converter_cancel
            .store(true, Ordering::Release);
        return;
    }
    {
        let state = app.state::<App>();
        state.converter_control.stop();
        state.converter_cancel.store(true, Ordering::Release);
    }
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let app = app.state::<App>();
        app.converter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stop();
    })
    .await;
}

#[tauri::command]
pub async fn converter_pick(
    app: tauri::AppHandle,
    kind: String,
    device: Option<String>,
) -> Result<Option<serde_json::Value>, Error> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<serde_json::Value>, String> {
        use tauri_plugin_dialog::DialogExt;
        let extensions = match kind.as_str() {
            "midi" => vec!["mid", "midi"],
            "media" => vec![
                "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "mp4", "webm", "avi",
                "mov", "mkv", "flv", "wmv", "m4v",
            ],
            "soundfont" => vec!["sf2"],
            "background" => vec!["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov"],
            "import" => vec![],
            _ => return Err("Unknown converter file type.".into()),
        };
        let path = if kind == "import" {
            app.dialog()
                .file()
                .set_title("Import history and MIDI · choose converter or MIDI folder")
                .blocking_pick_folder()
        } else {
            app.dialog()
                .file()
                .add_filter(&kind, &extensions)
                .blocking_pick_file()
        };
        let Some(path) = path else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        let state = app.state::<App>();
        let mut converter = state
            .converter
            .lock()
            .map_err(|_| "Converter unavailable.".to_string())?;
        converter.start(&app)?;
        let service = converter.process.as_ref().unwrap();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(120))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let endpoint = match kind.as_str() {
            "midi" => "/api/upload-midi",
            "media" => "/api/upload-media",
            "soundfont" => "/api/upload-soundfont",
            "background" => "/api/visualizer-background",
            _ => "/api/import-data",
        };
        let request = client
            .post(format!("http://127.0.0.1:{}{endpoint}", service.port))
            .header("X-Lazymidi-Token", &service.token);
        let response = if kind == "import" {
            request.json(&serde_json::json!({"source":path})).send()
        } else {
            if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 * 1024 {
                return Err("File exceeds 2 GiB.".into());
            }
            let form = reqwest::blocking::multipart::Form::new()
                .file("file", path)
                .map_err(|e| e.to_string())?
                .text("device", device.unwrap_or_else(|| "cpu".into()));
            request.multipart(form).send()
        }
        .map_err(|e| e.to_string())?;
        let success = response.status().is_success();
        let value: serde_json::Value = response.json().map_err(|e| e.to_string())?;
        if !success {
            return Err(value["error"]
                .as_str()
                .unwrap_or("Converter import failed.")
                .into());
        }
        Ok(Some(value))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(Error::from)
}
#[tauri::command]
pub async fn converter_export(app: tauri::AppHandle, id: String) -> Result<(), Error> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use tauri_plugin_dialog::DialogExt;
        if !safe_name(&id)
            || !["mid", "midi", "txt"].contains(
                &Path::new(&id)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or(""),
            )
        {
            return Err("Invalid export ID.".into());
        }
        let source = scoped_file(&root(&app)?.join("data/converted"), &id)?;
        if let Some(path) = app.dialog().file().set_file_name(&id).blocking_save_file() {
            let path = path.into_path().map_err(|e| e.to_string())?;
            let parent = path.parent().ok_or("Invalid export directory.")?;
            let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            std::io::copy(
                &mut fs::File::open(source).map_err(|e| e.to_string())?,
                &mut temp,
            )
            .map_err(|e| e.to_string())?;
            temp.as_file().sync_all().map_err(|e| e.to_string())?;
            temp.persist(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(Error::from)
}
const MEDIA_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
fn media_range(length: u64, range: Option<&str>) -> Result<(u64, u64, u16), String> {
    if length == 0 {
        return Err("Empty media.".into());
    }
    let Some(range) = range else {
        if length > 64 * 1024 * 1024 {
            return Err("Media requires byte-range loading.".into());
        }
        return Ok((0, length - 1, 200));
    };
    let (a, b) = range
        .strip_prefix("bytes=")
        .and_then(|r| r.split_once('-'))
        .ok_or("Invalid range.")?;
    let start = a.parse::<u64>().map_err(|e| e.to_string())?;
    let requested_end = if b.is_empty() {
        length - 1
    } else {
        b.parse::<u64>().map_err(|e| e.to_string())?.min(length - 1)
    };
    let end = requested_end.min(start.saturating_add(MEDIA_CHUNK_BYTES - 1));
    if start > end || end >= length {
        return Err("Invalid range.".into());
    }
    Ok((start, end, 206))
}
pub fn media(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let result = (|| -> Result<tauri::http::Response<Vec<u8>>, String> {
        use std::io::{Seek, SeekFrom};
        if request.method() != tauri::http::Method::GET {
            return Err("Read-only media.".into());
        }
        let origin = request
            .headers()
            .get("Origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if ![
            "",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
            "http://127.0.0.1:1420",
        ]
        .contains(&origin)
        {
            return Err("Untrusted media origin.".into());
        }
        let path = percent_encoding::percent_decode_str(request.uri().path())
            .decode_utf8()
            .map_err(|e| e.to_string())?;
        let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
        if parts.len() != 2
            || !["converted", "soundfonts", "visualizer-backgrounds"].contains(&parts[0])
            || !safe_name(parts[1])
        {
            return Err("Invalid media ID.".into());
        }
        if !app.state::<App>().smoke_converter
            && !app
                .state::<App>()
                .runtime
                .snapshot()
                .settings
                .show_converter
        {
            return Err("Converter disabled.".into());
        }
        let file = scoped_file(&root(app)?.join("data").join(parts[0]), parts[1])?;
        let extension = file
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match extension.as_str() {
            "mid" | "midi" => "audio/midi",
            "txt" => "text/plain; charset=utf-8",
            "sf2" => "application/octet-stream",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            _ => return Err("Unsupported media.".into()),
        };
        let mut file = fs::File::open(file).map_err(|e| e.to_string())?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        // WebView2 copies response bodies; a whole multi-GB SF2 crashes the host.
        let (start, end, status) = media_range(
            length,
            request.headers().get("Range").and_then(|v| v.to_str().ok()),
        )?;
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(end - start + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let mut response = tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header(
                "Access-Control-Allow-Origin",
                if origin.is_empty() {
                    "http://tauri.localhost"
                } else {
                    origin
                },
            )
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", bytes.len())
            .header("Access-Control-Expose-Headers", "Content-Range");
        if status == 206 {
            response = response.header("Content-Range", format!("bytes {start}-{end}/{length}"));
        }
        response.body(bytes).map_err(|e| e.to_string())
    })();
    result.unwrap_or_else(|e| {
        tauri::http::Response::builder()
            .status(404)
            .body(e.into_bytes())
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_delivery_is_bounded_even_for_multi_gigabyte_fonts() {
        let size = 1_817_430_906;
        assert!(media_range(size, None).is_err());
        assert_eq!(
            media_range(size, Some("bytes=0-1817430905")).unwrap(),
            (0, MEDIA_CHUNK_BYTES - 1, 206)
        );
        assert_eq!(
            media_range(size, Some("bytes=1817430896-")).unwrap(),
            (size - 10, size - 1, 206)
        );
        assert_eq!(media_range(10, None).unwrap(), (0, 9, 200));
        for range in [
            "bytes=20-30",
            "bytes=5-2",
            "bytes=0-1,3-4",
            "bytes=18446744073709551615-",
        ] {
            assert!(media_range(10, Some(range)).is_err());
        }
    }
    #[test]
    fn existing_runtime_selection_and_old_packs_are_compatible() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let python = root.join(".cuda-venv/Scripts/python.exe");
        fs::create_dir_all(python.parent().unwrap()).unwrap();
        fs::write(&python, b"test").unwrap();
        let ffmpeg = root.join("ffmpeg.exe");
        let ffprobe = root.join("ffprobe.exe");
        fs::write(&ffmpeg, b"test").unwrap();
        fs::write(&ffprobe, b"test").unwrap();
        assert_eq!(environment_candidates(root).unwrap(), vec![python.clone()]);
        assert!(environment_candidates(Path::new("relative")).is_err());
        let environment = ExistingEnvironment {
            python: python.clone(),
            ffmpeg,
            ffprobe,
            python_version: "3.10.19".into(),
            torch_version: "2.9.1+cu128".into(),
            cuda_available: true,
            cuda_error: None,
        };
        config::atomic_save(
            &root.join("active.json"),
            &RuntimeSelection::Existing(environment),
        )
        .unwrap();
        let runtime = active_runtime(root).unwrap();
        assert_eq!(runtime.python, python);
        assert_eq!(runtime.variant, "cuda");
        assert!(validate_environment(root, root, &AtomicBool::new(true))
            .unwrap_err()
            .contains("cancelled"));
        fs::remove_file(&python).unwrap();
        assert!(active_runtime(root).unwrap_err().contains("missing"));
        fs::create_dir_all(root.join("runtimes/cpu")).unwrap();
        config::atomic_save(
            &root.join("runtimes/cpu/pack.json"),
            &serde_json::json!({"variant":"cpu"}),
        )
        .unwrap();
        config::atomic_save(&root.join("active.json"), &"cpu").unwrap();
        assert_eq!(active_runtime(root).unwrap().variant, "cpu");
        assert!(active_runtime(root).unwrap().environment.is_none());
    }
    #[test]
    #[ignore = "Checks an explicitly selected existing Python environment without installing anything"]
    fn installed_existing_environment_is_usable() {
        let path = PathBuf::from(
            std::env::var_os("LAZYMIDI_TEST_EXISTING_ENVIRONMENT")
                .expect("Set LAZYMIDI_TEST_EXISTING_ENVIRONMENT"),
        );
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../converter");
        let environment = validate_environment(&path, &source, &AtomicBool::new(false)).unwrap();
        assert!(environment.python_version.starts_with("3."));
        assert!(environment.ffmpeg.is_file());
        assert!(environment.ffprobe.is_file());
        let temp = tempfile::tempdir().unwrap();
        config::atomic_save(
            &temp.path().join("active.json"),
            &RuntimeSelection::Existing(environment.clone()),
        )
        .unwrap();
        assert_eq!(
            active_runtime(temp.path()).unwrap().python,
            environment.python
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            signal.store(true, Ordering::Release);
        });
        let started = Instant::now();
        assert!(validate_environment(&path, &source, &cancel)
            .unwrap_err()
            .contains("cancelled"));
        trigger.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            active_runtime(temp.path()).unwrap().python,
            environment.python
        );
        if let Some(output) = std::env::var_os("LAZYMIDI_TEST_ENVIRONMENT_OUTPUT") {
            config::atomic_save(
                &PathBuf::from(output),
                &RuntimeSelection::Existing(environment),
            )
            .unwrap();
        }
    }
    #[test]
    fn exports_and_media_reads_stay_inside_storage() {
        let temp = tempfile::tempdir().unwrap();
        let scope = temp.path().join("converted");
        let outside = temp.path().join("outside");
        fs::create_dir(&scope).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(scope.join("test.mid"), b"MThd").unwrap();
        assert_eq!(
            scoped_file(&scope, "test.mid").unwrap(),
            scope.join("test.mid").canonicalize().unwrap()
        );
        for name in ["../outside", "missing.mid", "C:\\outside.mid"] {
            assert!(scoped_file(&scope, name).is_err());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            assert!(Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(scope.join("escaped"))
                .arg(&outside)
                .creation_flags(0x08000000)
                .output()
                .unwrap()
                .status
                .success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, scope.join("escaped")).unwrap();
        assert!(scoped_file(&scope, "escaped")
            .unwrap_err()
            .contains("escaped"));
    }
    #[test]
    fn approved_operations_exclude_arbitrary_paths() {
        assert!(approved("/api/history?limit=200", "GET"));
        assert!(!approved("/api/import-data", "POST"));
        assert!(!approved("http://example.com", "GET"));
        assert!(!approved("/api/status/../../settings", "GET"));
        assert!(!safe_name("../python.exe"));
        assert!(!safe_name("CON.txt"));
        assert!(!safe_name("path."));
    }
    fn fixture(directory: &Path, entries: &[(&str, &[u8])]) -> (PathBuf, Pack) {
        let path = directory.join("pack.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let mut installed = 0;
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
            installed += bytes.len() as u64;
        }
        zip.finish().unwrap();
        let bytes = fs::read(&path).unwrap();
        let pack = Pack {
            version: "test".into(),
            variant: "cpu".into(),
            platform: "windows-x86_64".into(),
            bytes: bytes.len() as u64,
            installed_bytes: installed,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            file: "pack.zip".into(),
            url: None,
            parts: vec![],
        };
        (path, pack)
    }
    #[test]
    fn failed_install_preserves_working_pack_and_cleans_staging() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        config::atomic_save(&root.join("active.json"), &"previous").unwrap();
        let cancel = AtomicBool::new(false);
        let status = Mutex::new(Status::default());
        for bad in [
            "../escape",
            "python/CON.txt",
            "Python/PYTHON.exe",
            "python/incomplete.exe",
        ] {
            let (archive, mut pack) =
                fixture(root, &[("python/python.exe", b"test"), (bad, b"bad")]);
            assert!(install_pack(root, &archive, &pack, &cancel, &status).is_err());
            pack.sha256 = "wrong".into();
            assert!(install_pack(root, &archive, &pack, &cancel, &status)
                .unwrap_err()
                .contains("checksum"));
            assert_eq!(
                config::read_json::<String>(&root.join("active.json")).unwrap(),
                "previous"
            );
            if root.join("runtimes").exists() {
                assert_eq!(fs::read_dir(root.join("runtimes")).unwrap().count(), 0);
            }
        }
        let (archive, pack) = fixture(
            root,
            &[
                ("pack.json", br#"{"version":"test","variant":"cpu"}"#),
                ("python/python.exe", b"test"),
                ("ffmpeg/ffmpeg.exe", b"test"),
            ],
        );
        cancel.store(true, Ordering::Release);
        assert!(install_pack(root, &archive, &pack, &cancel, &status)
            .unwrap_err()
            .contains("cancelled"));
        cancel.store(false, Ordering::Release);
        install_pack(root, &archive, &pack, &cancel, &status).unwrap();
        assert!(active_pack(root)
            .unwrap()
            .join("python/python.exe")
            .exists());
        assert!(root.join("active.backup").exists());
    }
    #[test]
    #[ignore = "Extracts the locally built CPU runtime into an isolated temporary directory"]
    fn built_cpu_pack_installs_and_runs() {
        let manifest =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/converter-packs/cpu.json");
        let pack: Pack = config::read_json(&manifest).unwrap();
        let root = tempfile::tempdir().unwrap();
        install_pack(
            root.path(),
            &manifest.parent().unwrap().join(&pack.file),
            &pack,
            &AtomicBool::new(false),
            &Mutex::new(Status::default()),
        )
        .unwrap();
        let active = active_pack(root.path()).unwrap();
        let mut cmd = std::process::Command::new(active.join("python/python.exe"));
        cmd.args([
            "-X",
            "utf8",
            "-c",
            "import torch,transkun,flask;print(torch.__version__)",
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
