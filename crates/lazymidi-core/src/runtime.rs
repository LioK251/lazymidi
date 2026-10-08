use crate::{
    analog::{AnalogDevice, AnalogProcessor},
    config::{self, Settings},
    devices::{Device, DeviceCommand},
    engine::{Engine, OutputAction},
    latency::{Metrics, Stage, Summary},
    midi::MidiEvent,
    routing::{Destination, Source},
    sequencer::{Project, Sequencer},
    Result,
};
use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub state_sequence: u64,
    pub latency: Option<std::collections::BTreeMap<String, Summary>>,
    pub revision: u64,
    pub settings: Settings,
    pub inputs: Vec<Device>,
    pub outputs: Vec<Device>,
    pub midi_connected: Option<String>,
    pub analog_devices: Vec<AnalogDevice>,
    pub analog_connected: Option<String>,
    pub sdk_found: Option<PathBuf>,
    pub sdk_version: Option<String>,
    pub analog_enabled: bool,
    pub analog_pending: bool,
    pub qwerty_enabled: bool,
    pub qwerty_pending: bool,
    pub paused: bool,
    pub keyboard_backend: String,
    pub warning: Option<String>,
    pub error: Option<String>,
    pub received: u64,
    pub dropped: u64,
    pub active_notes: Vec<(Source, u8, u8)>,
    pub last_event: Option<MidiEvent>,
    pub project: Project,
    pub project_dirty: bool,
    pub playing: bool,
    pub recording: bool,
    pub armed_track: u8,
    pub cursor: u8,
}
impl Snapshot {
    pub fn new(settings: Settings, warning: Option<String>) -> Self {
        let sdk_found = crate::analog::find_sdk(settings.sdk_path.as_deref());
        Self {
            state_sequence: 0,
            latency: None,
            revision: 0,
            settings,
            inputs: vec![],
            outputs: vec![],
            midi_connected: None,
            analog_devices: vec![],
            analog_connected: None,
            sdk_found,
            sdk_version: None,
            analog_enabled: false,
            analog_pending: false,
            qwerty_enabled: false,
            qwerty_pending: false,
            paused: false,
            keyboard_backend: crate::platform::backend_name().into(),
            warning,
            error: None,
            received: 0,
            dropped: 0,
            active_notes: vec![],
            last_event: None,
            project: Project::default(),
            project_dirty: false,
            playing: false,
            recording: false,
            armed_track: 0,
            cursor: 0,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Settings {
        settings: Settings,
        expected_revision: u64,
    },
    Qwerty {
        enabled: bool,
    },
    Analog {
        enabled: bool,
    },
    Pause {
        paused: bool,
    },
    Transport {
        action: String,
    },
    Arm {
        track: u8,
    },
    Cursor {
        step: u8,
    },
    Project {
        project: Project,
        expected_revision: u64,
    },
    ProjectSaved {
        project: Project,
    },
    CommitRecording,
    Panic,
    Refresh,
    Shutdown,
}
pub enum InputMessage {
    Midi {
        source: Source,
        event: MidiEvent,
        generation: u64,
        received: Instant,
    },
    Analog {
        values: Box<[f32; 256]>,
        generation: u64,
        received: Instant,
        sample_started: Instant,
    },
}
pub enum SystemMessage {
    Devices {
        inputs: Vec<Device>,
        outputs: Vec<Device>,
    },
    MidiConnection {
        device: Option<String>,
        error: Option<String>,
    },
    AnalogStatus {
        request: u64,
        devices: Vec<AnalogDevice>,
        selected: Option<String>,
        version: Option<String>,
        error: Option<String>,
        enabled: bool,
    },
    KeyboardReady {
        request: u64,
        enabled: bool,
        result: Result<()>,
    },
    OutputError {
        destination: String,
        error: String,
    },
    Warning(String),
}
struct Request {
    command: Command,
    reply: Sender<Result<Snapshot>>,
}
pub struct Runtime {
    commands: Sender<Request>,
    snapshot: Arc<RwLock<Snapshot>>,
    stopped: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
    latency: Option<Arc<Metrics>>,
    pub settings_path: PathBuf,
}
impl Runtime {
    pub fn start() -> Result<Self> {
        let directory = config::data_dir()?;
        Self::start_at(directory.join("settings.json"))
    }
    pub fn start_at(settings_path: PathBuf) -> Result<Self> {
        let (settings, warning) = config::load_settings(&settings_path);
        let snapshot = Arc::new(RwLock::new(Snapshot::new(settings, warning)));
        let (tx, rx) = bounded(64);
        let stopped = Arc::new(AtomicBool::new(false));
        let shared = snapshot.clone();
        let done = stopped.clone();
        let latency = (std::env::var("LAZYMIDI_LATENCY").as_deref() == Ok("1"))
            .then(|| Arc::new(Metrics::default()));
        let metrics = latency.clone();
        let join = thread::Builder::new()
            .name("lazymidi-engine".into())
            .spawn(move || run(rx, shared, done, metrics))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            commands: tx,
            snapshot,
            stopped,
            join: Mutex::new(Some(join)),
            latency,
            settings_path,
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        let state = self
            .snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        self.with_latency(state)
    }
    fn with_latency(&self, mut state: Snapshot) -> Snapshot {
        state.latency = self.latency.as_ref().map(|metrics| metrics.snapshot());
        state
    }
    pub fn command(&self, command: Command) -> Result<Snapshot> {
        if self.is_stopped() {
            return Err("Application is shutting down.".into());
        }
        let (tx, rx) = bounded(1);
        self.commands
            .send_timeout(Request { command, reply: tx }, Duration::from_secs(2))
            .map_err(|_| "Application command queue is busy.")?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Application worker did not respond.")?
            .map(|state| self.with_latency(state))
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    pub fn stop(&self) {
        if !self.is_stopped() {
            let _ = self.command(Command::Shutdown);
        }
        if let Some(join) = self.join.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = join.join();
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

enum OutputControl {
    Enable { enabled: bool, request: u64 },
    Reconnect,
    Shutdown,
}
struct OutputHandle {
    events: Sender<OutputMessage>,
    control: Sender<OutputControl>,
    generation: Arc<AtomicU64>,
    join: Option<JoinHandle<()>>,
    latency: Option<Arc<Metrics>>,
}
type OutputMessage = (u64, OutputAction, Option<EventTiming>);
#[derive(Clone)]
struct EventTiming {
    metrics: Arc<Metrics>,
    source: Source,
    received: Instant,
    queued: Instant,
}
impl OutputHandle {
    fn new(
        id: Option<String>,
        system: Sender<SystemMessage>,
        fault: Arc<AtomicBool>,
        latency: Option<Arc<Metrics>>,
    ) -> Self {
        let (events_tx, events_rx) = bounded(4096);
        let (control_tx, control_rx) = unbounded();
        let generation = Arc::new(AtomicU64::new(0));
        let gen = generation.clone();
        let join = thread::spawn(move || {
            output_worker(id, events_rx, control_rx, gen, system, fault, open_output)
        });
        Self {
            events: events_tx,
            control: control_tx,
            generation,
            join: Some(join),
            latency,
        }
    }
    fn send(&self, action: OutputAction, fault: &AtomicBool) {
        self.send_timed(action, fault, None);
    }
    fn send_timed(
        &self,
        action: OutputAction,
        fault: &AtomicBool,
        origin: Option<(Source, Instant)>,
    ) {
        let timing = self.latency.as_ref().and_then(|metrics| {
            origin.map(|(source, received)| EventTiming {
                metrics: metrics.clone(),
                source,
                received,
                queued: Instant::now(),
            })
        });
        if self
            .events
            .try_send((self.generation.load(Ordering::Acquire), action, timing))
            .is_err()
        {
            fault.store(true, Ordering::Release);
        }
    }
    fn flush(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    fn stop(&mut self) {
        self.flush();
        let _ = self.control.send(OutputControl::Shutdown);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}
enum NativeOutput {
    Keyboard(crate::platform::Keyboard),
    Midi(midir::MidiOutputConnection),
    #[cfg(test)]
    Test(TestWriter),
    #[cfg(test)]
    TestBatch {
        single: TestWriter,
        batch: TestBatchWriter,
    },
}
#[cfg(test)]
type TestWriter = Box<dyn FnMut(&OutputAction) -> Result<()> + Send>;
#[cfg(test)]
type TestBatchWriter = Box<dyn FnMut(&[OutputAction]) -> Result<()> + Send>;
impl NativeOutput {
    fn supports_batches(&self) -> bool {
        #[cfg(windows)]
        if matches!(self, Self::Keyboard(_)) {
            return true;
        }
        #[cfg(test)]
        if matches!(self, Self::TestBatch { .. }) {
            return true;
        }
        false
    }
    fn write_many(&mut self, actions: &[OutputAction]) -> Result<()> {
        #[cfg(windows)]
        if let Self::Keyboard(keyboard) = self {
            let keys = actions
                .iter()
                .map(|action| match action {
                    OutputAction::Key { hid, down } => Ok((*hid, *down)),
                    _ => Err("Invalid keyboard batch.".into()),
                })
                .collect::<Result<Vec<_>>>()?;
            return keyboard.write_many(&keys);
        }
        #[cfg(test)]
        if let Self::TestBatch { batch, .. } = self {
            return batch(actions);
        }
        for action in actions {
            self.write(action)?;
        }
        Ok(())
    }
    fn write(&mut self, action: &OutputAction) -> Result<()> {
        match (self, action) {
            #[cfg(test)]
            (Self::Test(write), action) => write(action),
            #[cfg(test)]
            (Self::TestBatch { single, .. }, action) => single(action),
            (Self::Keyboard(k), OutputAction::Key { hid, down }) => k.write(*hid, *down),
            (Self::Midi(m), OutputAction::Midi { event, .. }) => {
                let (bytes, len) = event.bytes();
                m.send(&bytes[..len]).map_err(|e| e.to_string())
            }
            _ => Ok(()),
        }
    }
}
fn open_output(id: Option<&str>) -> Result<NativeOutput> {
    if let Some(id) = id {
        let midi = midir::MidiOutput::new("lazymidi output").map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if id == "virtual:lazymidi" {
            use midir::os::unix::VirtualOutput;
            return midi
                .create_virtual("lazymidi Output")
                .map(NativeOutput::Midi)
                .map_err(|e| e.to_string());
        }
        let port = midi
            .find_port_by_id(id)
            .ok_or("MIDI output is no longer available.")?;
        midi.connect(&port, "lazymidi output")
            .map(NativeOutput::Midi)
            .map_err(|e| e.to_string())
    } else {
        crate::platform::Keyboard::new().map(NativeOutput::Keyboard)
    }
}
fn output_worker(
    id: Option<String>,
    events: Receiver<OutputMessage>,
    control: Receiver<OutputControl>,
    generation: Arc<AtomicU64>,
    system: Sender<SystemMessage>,
    fault: Arc<AtomicBool>,
    mut open: impl FnMut(Option<&str>) -> Result<NativeOutput>,
) {
    let destination = id.clone().unwrap_or_else(|| "qwerty".into());
    let mut native = None;
    let mut held: HashMap<(u8, u16, u8), OutputAction> = HashMap::new();
    let mut local_generation = generation.load(Ordering::Acquire);
    let release = |native: &mut Option<NativeOutput>,
                   held: &mut HashMap<(u8, u16, u8), OutputAction>| {
        let mut releases: Vec<_> = held.drain().map(|(_, action)| action).collect();
        releases.sort_by_key(|a| matches!(a, OutputAction::Key { hid: 224..=231, .. }));
        if let Some(output) = native {
            for action in releases {
                if let Err(error) = output.write(&action) {
                    let _ = system.send(SystemMessage::OutputError {
                        destination: destination.clone(),
                        error,
                    });
                }
            }
        }
    };
    if id.is_some() {
        match open(id.as_deref()) {
            Ok(n) => native = Some(n),
            Err(error) => {
                let _ = system.send(SystemMessage::OutputError {
                    destination: destination.clone(),
                    error,
                });
            }
        }
    }
    loop {
        let current = generation.load(Ordering::Acquire);
        if current != local_generation {
            release(&mut native, &mut held);
            local_generation = current;
        }
        crossbeam_channel::select_biased! {
            recv(control)->command=>match command {
                Ok(OutputControl::Enable{enabled,request})=>{
                    release(&mut native,&mut held);native=None;
                    let result=if enabled {match open(id.as_deref()){Ok(n)=>{native=Some(n);Ok(())},Err(e)=>Err(e)}}else{Ok(())};
                    let _=system.send(SystemMessage::KeyboardReady{request,enabled,result});
                },
                Ok(OutputControl::Reconnect)=>{release(&mut native,&mut held);native=None;match open(id.as_deref()){Ok(output)=>native=Some(output),Err(error)=>{let _=system.send(SystemMessage::OutputError{destination:destination.clone(),error});}}},
                Ok(OutputControl::Shutdown)|Err(_)=>break,
            },
            recv(events)->message=>{
                let Ok((mut epoch,action,timing))=message else {break;};
                if epoch!=generation.load(Ordering::Acquire){continue;}
                let batch = native.as_ref().is_some_and(NativeOutput::supports_batches);
                let mut messages = vec![(epoch, action, timing)];
                if batch { for _ in 0..7 { match events.try_recv() { Ok(next) => messages.push(next), Err(_) => break } } }
                epoch = generation.load(Ordering::Acquire);
                messages.retain(|message| message.0 == epoch);
                if messages.is_empty() { continue; }
                // Flush any in-flight older generation before delivering a newer event.
                if epoch!=local_generation{release(&mut native,&mut held);local_generation=epoch;}
                let started=messages.iter().any(|m| m.2.is_some()).then(Instant::now);
                for (_,_,timing) in &messages { if let (Some(timing),Some(started))=(timing,started){timing.metrics.record(Stage::KeyboardQueue,started.saturating_duration_since(timing.queued));} }
                let actions=crate::qwerty::keyboard_batch(messages.iter().map(|m| &m.1));
                let mut delivered=native.is_some();
                let batch_result = if batch {
                    if epoch!=generation.load(Ordering::Acquire) { release(&mut native,&mut held); continue; }
                    // Partial native insertion may have pressed any attempted key: cleanup covers them all.
                    for action in &actions { if let OutputAction::Key {hid,down:true}=action { held.insert((0,*hid,0),OutputAction::Key{hid:*hid,down:false}); } }
                    native.as_mut().map(|output| output.write_many(&actions))
                } else { None };
                for action in actions {if !batch && epoch!=generation.load(Ordering::Acquire){release(&mut native,&mut held);delivered=false;break;}
                if let Some(output)=native.as_mut(){
                    match batch_result.as_ref().cloned().unwrap_or_else(|| output.write(&action)){
                        Ok(())=>{match action {
                            OutputAction::Key{hid,down}=>{if down{held.insert((0,hid,0),OutputAction::Key{hid,down:false});}else{held.remove(&(0,hid,0));}},
                            OutputAction::Midi{id,event}=>{let key=(event.channel(),event.data1 as u16,if event.kind()==0xb0{0xb0}else{0x90});if event.kind()==0x90{held.insert(key,OutputAction::Midi{id,event:MidiEvent::note_off(event.channel(),event.data1)});}else if event.kind()==0x80{held.remove(&key);}else if event.kind()==0xb0 && matches!(event.data1,64|66){if event.data2>=64{held.insert(key,OutputAction::Midi{id,event:MidiEvent::cc(event.channel(),event.data1,0)});}else{held.remove(&key);}}},
                            _=>{}
                        }},
                        Err(error)=>{let _=system.send(SystemMessage::OutputError{destination:destination.clone(),error});if id.is_some(){fault.store(true,Ordering::Release);}release(&mut native,&mut held);native=None;delivered=false;break;}
                    }
                }
                }
                if batch && epoch!=generation.load(Ordering::Acquire) { release(&mut native,&mut held); delivered=false; }
                if delivered && id.is_none(){for (_,_,timing) in &messages {if let (Some(timing),Some(started))=(timing,started){let completed=Instant::now();timing.metrics.record(Stage::NativeSend,completed.duration_since(started));match timing.source{Source::Midi=>timing.metrics.record(Stage::MidiToSend,completed.saturating_duration_since(timing.received)),Source::Analog=>timing.metrics.record(Stage::AnalogToSend,completed.saturating_duration_since(timing.received)),_=>{}}}}}
            },
            default(Duration::from_millis(2))=>{}
        }
    }
    release(&mut native, &mut held);
}

enum AnalogCommand {
    Enable {
        request: u64,
        enabled: bool,
        path: Option<PathBuf>,
        device: Option<String>,
        hz: u16,
    },
    Shutdown,
}
#[cfg(feature = "wooting")]
fn analog_worker(
    commands: Receiver<AnalogCommand>,
    events: Sender<InputMessage>,
    system: Sender<SystemMessage>,
    generation: Arc<AtomicU64>,
    fault: Arc<AtomicBool>,
    latency: Option<Arc<Metrics>>,
) {
    #[cfg(not(feature = "wooting"))]
    let _ = &latency;
    #[cfg(feature = "wooting")]
    let mut sdk: Option<crate::analog::Sdk> = None;
    #[cfg(feature = "wooting")]
    let mut loaded_path = None;
    #[cfg(feature = "wooting")]
    let mut retired = Vec::new();
    let mut active = false;
    let mut selected = 0u64;
    let mut request_id = 0;
    let mut duration = Duration::from_millis(4);
    let mut next = Instant::now();
    let mut previous_sample: Option<Instant> = None;
    #[cfg(windows)]
    let mut timer: Option<crate::platform::PollTimer> = None;
    loop {
        let timeout = if active {
            next.saturating_duration_since(Instant::now())
        } else {
            Duration::from_secs(3600)
        };
        #[cfg(windows)]
        let precise = active && timer.as_ref().is_some_and(|t| t.wait(timeout).is_ok());
        #[cfg(windows)]
        if active && !precise {
            // Older Windows or a failed timer retains the channel-based polling fallback.
            timer = None;
        }
        #[cfg(windows)]
        let command = if precise {
            // Control changes wait at most one poll; ordinary channel timeouts can round to 15ms.
            commands.try_recv().map_err(|e| match e {
                crossbeam_channel::TryRecvError::Empty => {
                    crossbeam_channel::RecvTimeoutError::Timeout
                }
                crossbeam_channel::TryRecvError::Disconnected => {
                    crossbeam_channel::RecvTimeoutError::Disconnected
                }
            })
        } else {
            commands.recv_timeout(timeout)
        };
        #[cfg(not(windows))]
        let command = commands.recv_timeout(timeout);
        match command {
            Ok(AnalogCommand::Shutdown)
            | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            Ok(AnalogCommand::Enable {
                request,
                enabled,
                path,
                device,
                hz,
            }) => {
                generation.fetch_add(1, Ordering::SeqCst);
                active = false;
                previous_sample = None;
                #[cfg(windows)]
                {
                    timer = None;
                }
                request_id = request;
                #[cfg(feature = "wooting")]
                {
                    if let Some(s) = sdk.as_mut() {
                        s.stop();
                    }
                    let result =
                        (|| -> Result<(Vec<AnalogDevice>, Option<String>, Option<String>)> {
                            if !enabled {
                                return Ok((vec![], None, None));
                            }
                            let path=crate::analog::find_sdk(path.as_deref()).ok_or("Wooting Analog SDK is not installed. Install it separately, or use MIDI Controller input.")?;
                            if loaded_path.as_ref() != Some(&path) {
                                let replacement = crate::analog::Sdk::load(&path)?;
                                if let Some(old) = sdk.take() {
                                    retired.push(old);
                                }
                                sdk = Some(replacement);
                                loaded_path = Some(path);
                            }
                            let s = sdk.as_mut().ok_or("SDK unavailable.")?;
                            let version = s.start()?;
                            let devices = s.devices()?;
                            let chosen = if let Some(id) = device {
                                devices.iter().find(|d| d.id == id)
                            } else if devices.len() == 1 {
                                devices.first()
                            } else {
                                None
                            };
                            if let Some(d) = chosen {
                                selected = d.id.parse().map_err(|_| "Invalid device identity.")?;
                                active = true;
                                #[cfg(windows)]
                                {
                                    timer = crate::platform::PollTimer::new().ok();
                                }
                                duration = Duration::from_secs_f64(1.0 / hz as f64);
                                next = Instant::now();
                            }
                            let selected = chosen.map(|d| d.id.clone());
                            Ok((devices, selected, Some(version)))
                        })();
                    match result {
                        Ok((devices, selected, version)) => {
                            if enabled && !active {
                                if let Some(s) = sdk.as_mut() {
                                    s.stop();
                                }
                            }
                            let error = if enabled && !active {
                                Some(
                                    "Select an analog device. No unambiguous device is connected."
                                        .into(),
                                )
                            } else {
                                None
                            };
                            let _ = system.send(SystemMessage::AnalogStatus {
                                request,
                                devices,
                                selected,
                                version,
                                error,
                                enabled: active,
                            });
                        }
                        Err(error) => {
                            if let Some(s) = sdk.as_mut() {
                                s.stop();
                            }
                            let _ = system.send(SystemMessage::AnalogStatus {
                                request,
                                devices: vec![],
                                selected: None,
                                version: None,
                                error: Some(error),
                                enabled: false,
                            });
                        }
                    }
                }
                #[cfg(not(feature = "wooting"))]
                {
                    let _ = (enabled, path, device, hz);
                    let _ = system.send(SystemMessage::AnalogStatus {
                        request,
                        devices: vec![],
                        selected: None,
                        version: None,
                        error: Some("This build excludes Wooting support.".into()),
                        enabled: false,
                    });
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                #[cfg(feature = "wooting")]
                if active {
                    if let Some(s) = sdk.as_mut() {
                        let sample_started = Instant::now();
                        if let (Some(metrics), Some(previous)) = (&latency, previous_sample) {
                            metrics.record(
                                Stage::AnalogSampleInterval,
                                sample_started.duration_since(previous),
                            );
                        }
                        previous_sample = Some(sample_started);
                        match s.read(selected) {
                            Ok(values) => {
                                let received = Instant::now();
                                if let Some(metrics) = &latency {
                                    metrics.record(
                                        Stage::SdkRead,
                                        received.duration_since(sample_started),
                                    );
                                }
                                if events
                                    .try_send(InputMessage::Analog {
                                        values: Box::new(values),
                                        generation: generation.load(Ordering::Acquire),
                                        received,
                                        sample_started,
                                    })
                                    .is_err()
                                {
                                    fault.store(true, Ordering::Release);
                                }
                            }
                            Err(error) => {
                                active = false;
                                #[cfg(windows)]
                                {
                                    timer = None;
                                }
                                generation.fetch_add(1, Ordering::SeqCst);
                                s.stop();
                                let _ = system.send(SystemMessage::AnalogStatus {
                                    request: request_id,
                                    devices: vec![],
                                    selected: None,
                                    version: None,
                                    error: Some(error),
                                    enabled: false,
                                });
                            }
                        }
                    }
                }
                next += duration;
                if next < Instant::now() {
                    next = Instant::now() + duration;
                }
            }
        }
    }
    #[cfg(feature = "wooting")]
    if let Some(mut s) = sdk {
        s.stop();
    }
}

#[cfg(not(feature = "wooting"))]
fn analog_worker(
    commands: Receiver<AnalogCommand>,
    _events: Sender<InputMessage>,
    system: Sender<SystemMessage>,
    _generation: Arc<AtomicU64>,
    _fault: Arc<AtomicBool>,
    _latency: Option<Arc<Metrics>>,
) {
    while let Ok(AnalogCommand::Enable {
        request,
        enabled,
        path,
        device,
        hz,
    }) = commands.recv()
    {
        let _ = (path, device, hz);
        let _ = system.send(SystemMessage::AnalogStatus {
            request,
            devices: vec![],
            selected: None,
            version: None,
            error: enabled.then(|| "This build excludes Wooting support.".into()),
            enabled: false,
        });
    }
}

fn run(
    commands: Receiver<Request>,
    shared: Arc<RwLock<Snapshot>>,
    stopped: Arc<AtomicBool>,
    latency: Option<Arc<Metrics>>,
) {
    let mut state = shared.read().unwrap_or_else(|e| e.into_inner()).clone();
    let (mut engine, mut sequencer, mut analog) = (
        Engine::default(),
        Sequencer::default(),
        AnalogProcessor::default(),
    );
    let (input_tx, input_rx) = bounded(4096);
    let (system_tx, system_rx) = unbounded();
    let (device_tx, device_rx) = unbounded();
    let (analog_tx, analog_rx) = unbounded();
    let midi_generation = Arc::new(AtomicU64::new(0));
    let analog_generation = Arc::new(AtomicU64::new(0));
    let fault = Arc::new(AtomicBool::new(false));
    let device_join = {
        let tx = input_tx.clone();
        let sys = system_tx.clone();
        let gen = midi_generation.clone();
        let fault = fault.clone();
        let preference = state.settings.preferred_midi.clone();
        thread::spawn(move || crate::devices::run(device_rx, tx, sys, gen, fault, preference))
    };
    let analog_join = {
        let tx = input_tx;
        let sys = system_tx.clone();
        let gen = analog_generation.clone();
        let fault = fault.clone();
        let metrics = latency.clone();
        thread::spawn(move || analog_worker(analog_rx, tx, sys, gen, fault, metrics))
    };
    let mut keyboard = OutputHandle::new(None, system_tx.clone(), fault.clone(), latency.clone());
    let mut outputs: HashMap<String, OutputHandle> = HashMap::new();
    let (mut keyboard_request, mut analog_request) = (0u64, 0u64);
    let mut live_notes: HashSet<(Source, u8, u8)> = HashSet::new();
    let mut input_barrier = Instant::now();
    let mut qwerty_barrier = input_barrier;
    let mut next_snapshot = Instant::now();
    let mut rate = 0u32;
    let mut rate_start = Instant::now();
    let mut event_origin;
    macro_rules! dispatch {
        ($actions:expr) => {
            for action in $actions {
                match &action {
                    OutputAction::Key { .. } | OutputAction::Chord { .. } => {
                        if let Some(origin) = event_origin {
                            keyboard.send_timed(action, &fault, Some(origin));
                        } else {
                            keyboard.send(action, &fault);
                        }
                    }
                    OutputAction::Midi { id, .. } => {
                        if let Some(out) = outputs.get(id) {
                            out.send(action, &fault);
                        }
                    }
                    OutputAction::Record { track, event } => {
                        if *track == sequencer.armed {
                            sequencer.record(*event, Instant::now());
                        }
                    }
                }
            }
        };
    }
    for id in state
        .settings
        .profile()
        .routes
        .iter()
        .filter(|r| r.enabled)
        .filter_map(|r| {
            if let Destination::Midi(id) = &r.destination {
                Some(id.clone())
            } else {
                None
            }
        })
    {
        outputs
            .entry(id.clone())
            .or_insert_with(|| OutputHandle::new(Some(id), system_tx.clone(), fault.clone(), None));
    }
    macro_rules! flush {
        () => {
            input_barrier = Instant::now();
            engine.flush();
            keyboard.flush();
            for out in outputs.values() {
                out.flush();
            }
            analog.reset();
        };
    }
    macro_rules! disarm {
        () => {
            disarm_keyboard(&mut state, &mut engine, &keyboard, &mut keyboard_request);
        };
    }
    macro_rules! disable_analog {
        () => {
            analog_request += 1;
            state.analog_enabled = false;
            state.analog_pending = false;
            analog_generation.fetch_add(1, Ordering::SeqCst);
            let _ = analog_tx.send(AnalogCommand::Enable {
                request: analog_request,
                enabled: false,
                path: state.settings.sdk_path.clone(),
                device: state.settings.analog_device.clone(),
                hz: state.settings.polling_hz,
            });
        };
    }
    loop {
        event_origin = None;
        if fault.swap(false, Ordering::AcqRel) {
            state.dropped += 1;
            state.error=Some("Input/output overload or failure: transport stopped and generated output released. Enable output again after resolving the cause.".into());
            flush!();
            disarm!();
            disable_analog!();
            sequencer.stop();
        }
        let now = Instant::now();
        for (source, event) in sequencer.tick(now) {
            dispatch!(engine.process(
                source,
                event,
                state.settings.profile(),
                state.qwerty_enabled,
                state.paused
            ));
        }
        if now.duration_since(rate_start) >= Duration::from_secs(1) {
            rate = 0;
            rate_start = now;
        }
        let wait = sequencer
            .next_deadline()
            .map(|d| d.saturating_duration_since(now))
            .unwrap_or(Duration::from_millis(10))
            .min(Duration::from_millis(10));
        let mut reply = None;
        crossbeam_channel::select_biased! {
            recv(commands)->request=>{
                let Ok(request)=request else{break;};let mut result=Ok(());let mut shutdown=false;
                match request.command {
                    Command::Settings{settings,expected_revision}=>{
                        result=settings.validate().and_then(|_|if expected_revision!=state.revision{Err("Preferences changed. Reload your draft before applying.".into())}else{Ok(())});
                        if result.is_ok(){
                            let keep_analog=preserve_analog_connection(&state,&settings);
                            flush!();disarm!();if !keep_analog{disable_analog!();}
                            state.settings=settings;state.revision+=1;state.sdk_found=crate::analog::find_sdk(state.settings.sdk_path.as_deref());
                            let _=device_tx.send(DeviceCommand::Select(state.settings.preferred_midi.clone()));
                            let desired:HashSet<String>=state.settings.profile().routes.iter().filter(|r|r.enabled).filter_map(|r|if let Destination::Midi(id)=&r.destination{Some(id.clone())}else{None}).collect();
                            let removed:Vec<_>=outputs.keys().filter(|id|!desired.contains(*id)).cloned().collect();for id in removed{if let Some(mut out)=outputs.remove(&id){out.stop();}}
                            for id in desired{if let Some(out)=outputs.get(&id){let _=out.control.send(OutputControl::Reconnect);}else{outputs.insert(id.clone(),OutputHandle::new(Some(id),system_tx.clone(),fault.clone(),None));}}
                            state.error=None;
                        }
                    },
                    Command::Qwerty{enabled}=>{
                        if enabled && !state.playing && !state.analog_enabled && state.midi_connected.is_none(){result=Err("Connect a MIDI input, enable an analog device, or start sequencer playback before enabling QWERTY output.".into());}
                        else {flush!();keyboard_request+=1;state.qwerty_enabled=false;state.qwerty_pending=enabled;let _=keyboard.control.send(OutputControl::Enable{enabled,request:keyboard_request});state.error=None;}
                    },
                    Command::Analog{enabled}=>{
                        flush!();if !enabled{disarm!();}analog_request+=1;state.analog_enabled=false;state.analog_pending=enabled;let _=analog_tx.send(AnalogCommand::Enable{request:analog_request,enabled,path:state.settings.sdk_path.clone(),device:state.settings.analog_device.clone(),hz:state.settings.polling_hz});state.error=None;
                    },
                    Command::Pause{paused}=>pause_keyboard(&mut state,&mut engine,&keyboard,&mut qwerty_barrier,paused),
                    Command::Panic=>{flush!();disarm!();sequencer.stop();disable_analog!();state.error=None;},
                    Command::Refresh=>{let _=device_tx.send(DeviceCommand::Refresh);state.sdk_found=crate::analog::find_sdk(state.settings.sdk_path.as_deref());},
                    Command::Arm{track}=>{if track>3{result=Err("Invalid track.".into());}else{sequencer.commit_group();sequencer.armed=track;}},
                    Command::Cursor{step}=>{if step>15{result=Err("Invalid step.".into());}else{sequencer.commit_group();sequencer.cursor=step;}},
                    Command::Transport{action}=>match action.as_str(){"play"=>sequencer.play(Instant::now()),"stop"=>{let events=sequencer.stop();for(s,e)in events{dispatch!(engine.process(s,e,state.settings.profile(),state.qwerty_enabled,state.paused));}for t in 0..4 {dispatch!(engine.flush_source(Source::Sequencer(t)));}},"record"=>{sequencer.recording= !sequencer.recording;if !sequencer.recording{sequencer.commit_group();}},_=>result=Err("Unknown transport action.".into())},
                    Command::Project{project,expected_revision}=>{
                        result=project.validate().and_then(|_|if expected_revision!=state.revision{Err("Project changed. Reload before applying.".into())}else{Ok(())});
                        if result.is_ok(){for t in 0..4{dispatch!(engine.flush_source(Source::Sequencer(t)));}sequencer.project=project;sequencer.dirty=true;state.revision+=1;}
                    },
                    Command::ProjectSaved{project}=>{if project==sequencer.project{sequencer.dirty=false;}},
                    Command::CommitRecording=>sequencer.commit_group(),
                    Command::Shutdown=>shutdown=true,
                }
                if let Err(error)=&result{state.error=Some(error.clone());}
                reply=Some((request.reply,result));
                if shutdown {
                    engine.flush();keyboard.flush();for out in outputs.values(){out.flush();}
                    disarm!();disable_analog!();sequencer.stop();
                    let _=device_tx.send(DeviceCommand::Shutdown);let _=analog_tx.send(AnalogCommand::Shutdown);
                    let _=device_join.join();let _=analog_join.join();keyboard.stop();for out in outputs.values_mut(){out.stop();}
                    state.state_sequence+=1;state.playing=false;state.recording=false;state.active_notes.clear();
                    *shared.write().unwrap_or_else(|e|e.into_inner())=state.clone();
                    stopped.store(true,Ordering::Release);
                    if let Some((reply,_))=reply.take(){let _=reply.send(Ok(state.clone()));}break;
                }
            },
            recv(system_rx)->message=>if let Ok(message)=message{match message {
                SystemMessage::Devices{inputs,outputs:ports}=>{
                    for (id,output) in &outputs {let was=state.outputs.iter().any(|p|&p.id==id);let present=ports.iter().any(|p|&p.id==id);
                        if was&&!present {output.flush();fault.store(true,Ordering::Release);}
                        if !was&&present {let _=output.control.send(OutputControl::Reconnect);}
                    }
                    state.inputs=inputs;state.outputs=ports;#[cfg(unix)]state.outputs.push(Device{id:"virtual:lazymidi".into(),name:"Create lazymidi virtual output".into()});},
                SystemMessage::MidiConnection{device,error}=>{if state.midi_connected.is_some(){live_notes.retain(|(s,_,_)|*s!=Source::Midi);dispatch!(engine.flush_source(Source::Midi));disarm!();}state.midi_connected=device;if let Some(e)=error{state.error=Some(e);}},
                SystemMessage::AnalogStatus{request,devices,selected,version,error,enabled}=>if request==analog_request{live_notes.retain(|(s,_,_)|*s!=Source::Analog);dispatch!(engine.flush_source(Source::Analog));analog.reset();state.analog_devices=devices;state.analog_connected=selected;state.sdk_version=version;state.analog_enabled=enabled;state.analog_pending=false;if let Some(e)=error{state.error=Some(e);if !enabled{disarm!();}}},
                SystemMessage::KeyboardReady{request,enabled,result}=>if request==keyboard_request{state.qwerty_pending=false;match result{Ok(())=>state.qwerty_enabled=enabled&&(state.midi_connected.is_some()||state.analog_enabled||sequencer.playing),Err(error)=>{state.qwerty_enabled=false;state.error=Some(error);}}},
                SystemMessage::OutputError{destination,error}=>{state.error=Some(format!("{destination}: {error}"));if destination=="qwerty"{disarm!();}},
                SystemMessage::Warning(warning)=>state.warning=Some(warning),
            }},
            recv(input_rx)->message=>if let Ok(message)=message{
                rate+=1;if rate>20000{if rate==20001{fault.store(true,Ordering::Release);}}else{match message {
                    InputMessage::Midi{source,event,generation,received}=>if received>=input_barrier&&generation==midi_generation.load(Ordering::Acquire)&&(state.settings.input_mode==crate::config::InputMode::Midi||state.settings.both_inputs){state.last_event=Some(event);state.received+=1;if event.kind()==0x90{live_notes.insert((source,event.channel(),event.data1));}else if event.kind()==0x80{live_notes.remove(&(source,event.channel(),event.data1));}
                    if let Some(metrics)=&latency{metrics.record(Stage::MidiQueue,received.elapsed());}event_origin=Some((source,received));
                    if !state.settings.profile().routes.iter().any(|r|r.source==source&&matches!(r.destination,Destination::Recorder(_))){sequencer.record(event,received);}dispatch!(engine.process(source,event,state.settings.profile(),state.qwerty_enabled,state.paused||received<qwerty_barrier));},
                    InputMessage::Analog{values,generation,received,sample_started}=>if received>=input_barrier&&state.analog_enabled&&generation==analog_generation.load(Ordering::Acquire){if let Some(metrics)=&latency{metrics.record(Stage::AnalogQueue,received.elapsed());}event_origin=Some((Source::Analog,sample_started));for event in analog.process(&values,&state.settings.profile().analog,state.settings.aftertouch,received){let source=Source::Analog;state.last_event=Some(event);state.received+=1;if event.kind()==0x90{live_notes.insert((source,event.channel(),event.data1));}else if event.kind()==0x80{live_notes.remove(&(source,event.channel(),event.data1));}
                    if !state.settings.profile().routes.iter().any(|r|r.source==Source::Analog&&matches!(r.destination,Destination::Recorder(_))){sequencer.record(event,received);}dispatch!(engine.process(Source::Analog,event,state.settings.profile(),state.qwerty_enabled,state.paused||received<qwerty_barrier));}},
                }}
            },
            default(wait)=>{}
        }
        if Instant::now() >= next_snapshot || reply.is_some() {
            if state.project != sequencer.project {
                state.revision += 1;
            }
            state.project = sequencer.project.clone();
            state.project_dirty = sequencer.dirty;
            state.playing = sequencer.playing;
            state.recording = sequencer.recording;
            state.armed_track = sequencer.armed;
            state.cursor = sequencer.cursor;
            let mut activity: HashSet<_> = engine.active_notes().into_iter().collect();
            activity.extend(live_notes.iter().copied());
            state.active_notes = activity.into_iter().collect();
            state.active_notes.sort_by_key(|(_, c, n)| (*c, *n));
            state.state_sequence += 1;
            *shared.write().unwrap_or_else(|e| e.into_inner()) = state.clone();
            next_snapshot = Instant::now() + Duration::from_millis(34);
        }
        if let Some((tx, result)) = reply {
            let _ = tx.send(result.map(|_| state.clone()));
        }
    }
    stopped.store(true, Ordering::Release);
}

fn preserve_analog_connection(state: &Snapshot, settings: &Settings) -> bool {
    state.analog_enabled
        && state.settings.sdk_path == settings.sdk_path
        && state.settings.analog_device == settings.analog_device
        && state.settings.polling_hz == settings.polling_hz
        && state.settings.input_mode == settings.input_mode
        && state.settings.both_inputs == settings.both_inputs
}
fn pause_keyboard(
    state: &mut Snapshot,
    engine: &mut Engine,
    keyboard: &OutputHandle,
    barrier: &mut Instant,
    paused: bool,
) {
    if state.paused == paused {
        return;
    }
    engine.flush_qwerty();
    keyboard.flush();
    *barrier = Instant::now();
    state.paused = paused;
}
fn disarm_keyboard(
    state: &mut Snapshot,
    engine: &mut Engine,
    keyboard: &OutputHandle,
    request: &mut u64,
) {
    engine.flush_qwerty();
    state.qwerty_enabled = false;
    state.qwerty_pending = false;
    *request += 1;
    keyboard.flush();
    let _ = keyboard.control.send(OutputControl::Enable {
        enabled: false,
        request: *request,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_output() -> (
        OutputHandle,
        Receiver<OutputMessage>,
        Receiver<OutputControl>,
    ) {
        let (events, queued) = bounded(4096);
        let (control, controls) = unbounded();
        (
            OutputHandle {
                events,
                control,
                generation: Arc::new(AtomicU64::new(0)),
                join: None,
                latency: None,
            },
            queued,
            controls,
        )
    }
    #[test]
    fn keyboard_batches_release_on_partial_failure_cancellation_and_shutdown() {
        for (accepted, cancel) in [(0, false), (3, false), (20, false), (21, false), (21, true)] {
            let (keyboard, events, controls) = test_output();
            let generation = keyboard.generation.clone();
            let native_generation = generation.clone();
            let fault = Arc::new(AtomicBool::new(false));
            let worker_fault = fault.clone();
            let live = Arc::new(Mutex::new(HashSet::new()));
            let written = Arc::new(Mutex::new(Vec::new()));
            let single_live = live.clone();
            let batch_live = live.clone();
            let single_written = written.clone();
            let (system, status) = unbounded();
            let (batch_tx, batch_rx) = unbounded();
            keyboard
                .events
                .send((
                    0,
                    OutputAction::Chord {
                        hid: 20,
                        modifiers: vec![],
                        velocity: Some(100),
                    },
                    None,
                ))
                .unwrap();
            keyboard.generation.store(1, Ordering::SeqCst);
            for hid in 4..12 {
                keyboard.send(
                    OutputAction::Chord {
                        hid,
                        modifiers: vec![],
                        velocity: Some(100),
                    },
                    &fault,
                );
            }
            keyboard
                .control
                .send(OutputControl::Enable {
                    enabled: true,
                    request: 1,
                })
                .unwrap();
            let worker = thread::spawn(move || {
                output_worker(
                    None,
                    events,
                    controls,
                    generation,
                    system,
                    worker_fault,
                    move |_| {
                        let single_live = single_live.clone();
                        let single_written = single_written.clone();
                        let batch_live = batch_live.clone();
                        let batch_tx = batch_tx.clone();
                        let native_generation = native_generation.clone();
                        Ok(NativeOutput::TestBatch {
                            single: Box::new(move |action| {
                                if let OutputAction::Key { hid, down } = action {
                                    let mut live = single_live.lock().unwrap();
                                    if *down {
                                        live.insert(*hid);
                                    } else {
                                        live.remove(hid);
                                    }
                                }
                                single_written.lock().unwrap().push(action.clone());
                                Ok(())
                            }),
                            batch: Box::new(move |actions| {
                                for action in actions.iter().take(accepted) {
                                    if let OutputAction::Key { hid, down } = action {
                                        let mut live = batch_live.lock().unwrap();
                                        if *down {
                                            live.insert(*hid);
                                        } else {
                                            live.remove(hid);
                                        }
                                    }
                                }
                                if cancel {
                                    native_generation.fetch_add(1, Ordering::SeqCst);
                                }
                                batch_tx.send(actions.to_vec()).unwrap();
                                if accepted < actions.len() {
                                    Err("Partial keyboard insertion.".into())
                                } else {
                                    Ok(())
                                }
                            }),
                        })
                    },
                )
            });
            assert!(matches!(
                status.recv_timeout(Duration::from_secs(2)).unwrap(),
                SystemMessage::KeyboardReady { enabled: true, .. }
            ));
            let batch = batch_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(batch.len(), 21);
            assert!(!batch.contains(&OutputAction::Key {
                hid: 20,
                down: true
            }));
            if accepted < 21 {
                assert!(matches!(
                    status.recv_timeout(Duration::from_secs(2)).unwrap(),
                    SystemMessage::OutputError { .. }
                ));
            }
            keyboard.control.send(OutputControl::Shutdown).unwrap();
            worker.join().unwrap();
            assert!(!fault.load(Ordering::Acquire));
            assert!(
                live.lock().unwrap().is_empty(),
                "accepted={accepted}, cancel={cancel}"
            );
            let releases = written.lock().unwrap();
            for hid in 4..12 {
                assert!(releases.contains(&OutputAction::Key { hid, down: false }));
            }
            if accepted < 21 {
                assert_eq!(
                    releases.last(),
                    Some(&OutputAction::Key {
                        hid: 226,
                        down: false
                    })
                );
            }
        }
    }
    #[test]
    fn keyboard_pause_is_idempotent_and_preserves_analog_midi_and_recording() {
        let mut state = Snapshot::new(Settings::default(), None);
        state.analog_enabled = true;
        state.qwerty_enabled = true;
        state.recording = true;
        let mut profile = config::visual_profile();
        profile.routes.push(crate::routing::Route {
            id: "midi-out".into(),
            source: Source::Analog,
            destination: Destination::Midi("synth".into()),
            enabled: true,
            channel: None,
            remap_channel: None,
        });
        let mut engine = Engine::default();
        let mut analog = AnalogProcessor::default();
        let (keyboard, _, controls) = test_output();
        let mut barrier = Instant::now();
        let mut depths = [0.0; 256];
        depths[23] = 0.75;
        for event in analog.process(&depths, &profile.analog, false, Instant::now()) {
            engine.process(Source::Analog, event, &profile, true, false);
        }
        engine.process(
            Source::Analog,
            MidiEvent::cc(0, 64, 127),
            &profile,
            true,
            false,
        );
        pause_keyboard(&mut state, &mut engine, &keyboard, &mut barrier, true);
        assert!(state.analog_enabled && state.qwerty_enabled && state.recording);
        assert!(controls.is_empty());
        let generation = keyboard.generation.load(Ordering::Acquire);
        let cutoff = barrier;
        pause_keyboard(&mut state, &mut engine, &keyboard, &mut barrier, true);
        assert_eq!(keyboard.generation.load(Ordering::Acquire), generation);
        assert_eq!(barrier, cutoff);
        // A held analog note isn't reset/retriggered when navigating.
        assert!(analog
            .process(&depths, &profile.analog, false, Instant::now())
            .is_empty());
        pause_keyboard(&mut state, &mut engine, &keyboard, &mut barrier, false);
        assert!(state.analog_enabled && state.qwerty_enabled);
        depths[23] = 0.0;
        let releases: Vec<_> = analog
            .process(&depths, &profile.analog, false, Instant::now())
            .into_iter()
            .flat_map(|event| engine.process(Source::Analog, event, &profile, true, false))
            .collect();
        assert_eq!(
            releases,
            vec![OutputAction::Midi {
                id: "synth".into(),
                event: MidiEvent::note_off(0, 60)
            }]
        );
        assert_eq!(
            engine.process(
                Source::Analog,
                MidiEvent::cc(0, 64, 0),
                &profile,
                true,
                false
            ),
            vec![OutputAction::Midi {
                id: "synth".into(),
                event: MidiEvent::cc(0, 64, 0)
            }]
        );
        depths[23] = 0.75;
        assert_eq!(
            analog
                .process(&depths, &profile.analog, false, Instant::now())
                .len(),
            1
        );
        assert!(engine.flush().is_empty());
    }
    #[test]
    fn failed_keyboard_send_disarms_only_keyboard_and_cleans_partial_chords() {
        let (keyboard, events, controls) = test_output();
        let (system, status) = unbounded();
        let fault = Arc::new(AtomicBool::new(false));
        let written = Arc::new(Mutex::new(Vec::new()));
        let writes = written.clone();
        let gen = keyboard.generation.clone();
        let worker_fault = fault.clone();
        let worker = thread::spawn(move || {
            output_worker(
                None,
                events,
                controls,
                gen,
                system,
                worker_fault,
                move |_| {
                    let writes = writes.clone();
                    Ok(NativeOutput::Test(Box::new(move |action| {
                        writes.lock().unwrap().push(action.clone());
                        if matches!(
                            action,
                            OutputAction::Key {
                                hid: 30,
                                down: true
                            }
                        ) {
                            Err("injected send failure".into())
                        } else {
                            Ok(())
                        }
                    })))
                },
            )
        });
        keyboard
            .control
            .send(OutputControl::Enable {
                enabled: true,
                request: 1,
            })
            .unwrap();
        assert!(matches!(
            status.recv_timeout(Duration::from_secs(2)).unwrap(),
            SystemMessage::KeyboardReady { enabled: true, .. }
        ));
        keyboard.send(
            OutputAction::Chord {
                hid: 30,
                modifiers: vec![225],
                velocity: None,
            },
            &fault,
        );
        assert!(
            matches!(status.recv_timeout(Duration::from_secs(2)).unwrap(),SystemMessage::OutputError{destination,..} if destination=="qwerty")
        );
        let mut state = Snapshot::new(Settings::default(), None);
        state.analog_enabled = true;
        state.qwerty_enabled = true;
        let mut engine = Engine::default();
        let mut request = 1;
        disarm_keyboard(&mut state, &mut engine, &keyboard, &mut request);
        keyboard.control.send(OutputControl::Shutdown).unwrap();
        worker.join().unwrap();
        assert!(!fault.load(Ordering::Acquire));
        assert!(state.analog_enabled && !state.qwerty_enabled);
        assert_eq!(
            written.lock().unwrap().last(),
            Some(&OutputAction::Key {
                hid: 225,
                down: false
            })
        );
    }
    #[test]
    #[ignore = "timing comparison; run explicitly in release mode with --nocapture"]
    fn simulated_input_to_keyboard_latency() {
        for source in [Source::Midi, Source::Analog] {
            for hz in [250, 500, 1000] {
                for velocity in [false, true] {
                    let metrics = Arc::new(Metrics::default());
                    let (mut keyboard, events, controls) = test_output();
                    keyboard.latency = Some(metrics.clone());
                    let (system, status) = unbounded();
                    let (sent, delivered) = unbounded();
                    let gen = keyboard.generation.clone();
                    let worker = thread::spawn(move || {
                        output_worker(
                            None,
                            events,
                            controls,
                            gen,
                            system,
                            Arc::new(AtomicBool::new(false)),
                            move |_| {
                                let sent = sent.clone();
                                Ok(NativeOutput::Test(Box::new(move |action| {
                                    std::hint::black_box(action);
                                    let _ = sent.send(action.clone());
                                    Ok(())
                                })))
                            },
                        )
                    });
                    keyboard
                        .control
                        .send(OutputControl::Enable {
                            enabled: true,
                            request: 1,
                        })
                        .unwrap();
                    status.recv_timeout(Duration::from_secs(2)).unwrap();
                    let (inputs, queue) = bounded::<(Instant, Vec<MidiEvent>)>(4096);
                    let engine_metrics = metrics.clone();
                    let engine_worker = thread::spawn(move || {
                        let mut profile = config::visual_profile();
                        profile.game_velocity = velocity;
                        let mut engine = Engine::default();
                        let fault = AtomicBool::new(false);
                        while let Ok((received, events)) = queue.recv() {
                            engine_metrics.record(
                                if source == Source::Midi {
                                    Stage::MidiQueue
                                } else {
                                    Stage::AnalogQueue
                                },
                                received.elapsed(),
                            );
                            for event in events {
                                for action in engine.process(source, event, &profile, true, false) {
                                    keyboard.send_timed(action, &fault, Some((source, received)));
                                }
                            }
                        }
                        assert!(!fault.load(Ordering::Acquire));
                        keyboard
                    });
                    let profile = config::visual_profile();
                    let mut analog = AnalogProcessor::default();
                    let mut depths = [0.0; 256];
                    let period = Duration::from_secs_f64(1.0 / hz as f64);
                    let origin = Instant::now();
                    for sample in 0..1000 {
                        let deadline = origin + period * sample;
                        if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
                            thread::sleep(wait);
                        }
                        let now = Instant::now();
                        let down = sample % 2 == 0;
                        let events = if source == Source::Midi {
                            vec![MidiEvent::parse(&[
                                if down { 0x90 } else { 0x80 },
                                60,
                                if down { 100 } else { 0 },
                            ])
                            .unwrap()]
                        } else {
                            depths[23] = if down { 0.75 } else { 0.0 };
                            analog.process(&depths, &profile.analog, false, now)
                        };
                        inputs.send((now, events)).unwrap();
                        // Synchronize delivery without timing the assertion/channel consumer.
                        let expected = if down {
                            crate::qwerty::chord(23, &[], velocity.then_some(100)).len()
                        } else {
                            1
                        };
                        for _ in 0..expected {
                            delivered.recv_timeout(Duration::from_secs(2)).unwrap();
                        }
                    }
                    drop(inputs);
                    let mut keyboard = engine_worker.join().unwrap();
                    keyboard.control.send(OutputControl::Shutdown).unwrap();
                    worker.join().unwrap();
                    keyboard.join = None;
                    assert!(delivered.is_empty());
                    let snapshot = metrics.snapshot();
                    let summary = &snapshot[if source == Source::Midi {
                        "midi_to_send"
                    } else {
                        "analog_to_send"
                    }];
                    assert_eq!(summary.count, 1000);
                    println!("source={source:?}, poll={hz}Hz, velocity={velocity}: p50={:.1}us p95={:.1}us p99={:.1}us max={:.1}us (simulated input/native writer)",summary.p50_us,summary.p95_us,summary.p99_us,summary.max_us);
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "native Windows timing: injects only neutral F24 release events; no game notes"]
    fn native_keyboard_burst_latency() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
        fn send(count: usize) -> Result<()> {
            let inputs = vec![
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: 0,
                            wScan: 0x76,
                            dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0x4c415a59,
                        }
                    }
                };
                count
            ];
            // SAFETY: initialized neutral key releases, exact INPUT ABI size.
            let sent = unsafe {
                SendInput(
                    count as u32,
                    inputs.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                )
            };
            if sent as usize == count {
                Ok(())
            } else {
                Err("Native calibration insertion failed.".into())
            }
        }
        for source in [Source::Midi, Source::Analog] {
            for batch in [false, true] {
                let (keyboard, events, controls) = test_output();
                let generation = keyboard.generation.clone();
                let fault = Arc::new(AtomicBool::new(false));
                let worker_fault = fault.clone();
                let (system, status) = unbounded();
                let (done, delivered) = unbounded();
                let worker = thread::spawn(move || {
                    output_worker(
                        None,
                        events,
                        controls,
                        generation,
                        system,
                        worker_fault,
                        move |_| {
                            let single_done = done.clone();
                            let single: TestWriter = Box::new(move |action| {
                                send(1)?;
                                if let OutputAction::Key { hid: 22, down } = action {
                                    single_done.send(*down).unwrap();
                                }
                                Ok(())
                            });
                            if batch {
                                let done = done.clone();
                                Ok(NativeOutput::TestBatch {
                                    single,
                                    batch: Box::new(move |actions| {
                                        send(actions.len())?;
                                        if let Some(OutputAction::Key { down, .. }) =
                                            actions.iter().rev().find(|a| {
                                                matches!(a, OutputAction::Key { hid: 22, .. })
                                            })
                                        {
                                            done.send(*down).unwrap();
                                        }
                                        Ok(())
                                    }),
                                })
                            } else {
                                Ok(NativeOutput::Test(single))
                            }
                        },
                    )
                });
                keyboard
                    .control
                    .send(OutputControl::Enable {
                        enabled: true,
                        request: 1,
                    })
                    .unwrap();
                status.recv_timeout(Duration::from_secs(2)).unwrap();
                let mut engine = Engine::default();
                let profile = config::visual_profile();
                let mut timings = Vec::new();
                for _ in 0..100 {
                    let started = Instant::now();
                    for note in [60, 62, 64, 65, 67, 69, 71, 72] {
                        for action in engine.process(
                            source,
                            MidiEvent::note_on(0, note, 100),
                            &profile,
                            true,
                            false,
                        ) {
                            keyboard.send(action, &fault);
                        }
                    }
                    while !delivered.recv_timeout(Duration::from_secs(2)).unwrap() {}
                    timings.push(started.elapsed().as_nanos());
                    for note in [60, 62, 64, 65, 67, 69, 71, 72] {
                        for action in engine.process(
                            source,
                            MidiEvent::note_off(0, note),
                            &profile,
                            true,
                            false,
                        ) {
                            keyboard.send(action, &fault);
                        }
                    }
                    assert!(!delivered.recv_timeout(Duration::from_secs(2)).unwrap());
                }
                keyboard.control.send(OutputControl::Shutdown).unwrap();
                worker.join().unwrap();
                assert!(!fault.load(Ordering::Acquire));
                assert!(status.try_recv().is_err());
                timings.sort_unstable();
                println!("source={source:?}, batch={batch}: 8-note burst p50={:.3}ms p99={:.3}ms; real engine/output queue and Windows send, neutral releases",timings[49] as f64/1e6,timings[98] as f64/1e6);
            }
        }
    }
    #[test]
    fn response_edits_keep_only_an_existing_unchanged_analog_connection() {
        let mut state = Snapshot::new(Settings::default(), None);
        let mut settings = state.settings.clone();
        settings.profiles[1].analog.shift_amount = 2;
        settings.profiles[1].analog.note_config.threshold = 0.25;
        settings.profiles[1].analog.note_config.velocity_scale = 0.62;
        assert!(!preserve_analog_connection(&state, &settings));
        state.analog_enabled = true;
        assert!(preserve_analog_connection(&state, &settings));
        let mut changed = settings.clone();
        changed.polling_hz = 500;
        assert!(!preserve_analog_connection(&state, &changed));
        changed = settings.clone();
        changed.analog_device = Some("other".into());
        assert!(!preserve_analog_connection(&state, &changed));
        changed = settings.clone();
        changed.sdk_path = Some("other.dll".into());
        assert!(!preserve_analog_connection(&state, &changed));
        changed = settings.clone();
        changed.input_mode = crate::config::InputMode::Midi;
        assert!(!preserve_analog_connection(&state, &changed));
        changed = settings;
        changed.both_inputs = true;
        assert!(!preserve_analog_connection(&state, &changed));
    }
    #[test]
    fn saturated_output_queue_cannot_swallow_fault_or_cleanup() {
        let (events, queued) = bounded(4096);
        let (control, controls) = unbounded();
        let generation = Arc::new(AtomicU64::new(0));
        let output = OutputHandle {
            events,
            control,
            generation: generation.clone(),
            join: None,
            latency: None,
        };
        let fault = AtomicBool::new(false);
        for _ in 0..4096 {
            output.send(
                OutputAction::Key {
                    hid: 30,
                    down: true,
                },
                &fault,
            );
        }
        assert!(!fault.load(Ordering::Acquire));
        output.send(
            OutputAction::Key {
                hid: 30,
                down: false,
            },
            &fault,
        );
        assert!(fault.load(Ordering::Acquire));
        output.flush();
        output.control.send(OutputControl::Shutdown).unwrap();
        assert!(matches!(controls.try_recv(), Ok(OutputControl::Shutdown)));
        assert!(queued
            .try_iter()
            .all(|(epoch, _, _)| epoch != generation.load(Ordering::Acquire)));
    }
}
