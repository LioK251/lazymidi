use crate::{
    analog::{AnalogDevice, AnalogProcessor},
    config::{self, Settings},
    devices::{Device, DeviceCommand},
    engine::{Engine, OutputAction},
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
        let join = thread::Builder::new()
            .name("lazymidi-engine".into())
            .spawn(move || run(rx, shared, done))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            commands: tx,
            snapshot,
            stopped,
            join: Mutex::new(Some(join)),
            settings_path,
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
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
    events: Sender<(u64, OutputAction)>,
    control: Sender<OutputControl>,
    generation: Arc<AtomicU64>,
    join: Option<JoinHandle<()>>,
}
impl OutputHandle {
    fn new(id: Option<String>, system: Sender<SystemMessage>, fault: Arc<AtomicBool>) -> Self {
        let (events_tx, events_rx) = bounded(4096);
        let (control_tx, control_rx) = unbounded();
        let generation = Arc::new(AtomicU64::new(0));
        let gen = generation.clone();
        let join =
            thread::spawn(move || output_worker(id, events_rx, control_rx, gen, system, fault));
        Self {
            events: events_tx,
            control: control_tx,
            generation,
            join: Some(join),
        }
    }
    fn send(&self, action: OutputAction, fault: &AtomicBool) {
        if self
            .events
            .try_send((self.generation.load(Ordering::Acquire), action))
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
}
impl NativeOutput {
    fn write(&mut self, action: &OutputAction) -> Result<()> {
        match (self, action) {
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
    events: Receiver<(u64, OutputAction)>,
    control: Receiver<OutputControl>,
    generation: Arc<AtomicU64>,
    system: Sender<SystemMessage>,
    fault: Arc<AtomicBool>,
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
        match open_output(id.as_deref()) {
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
                    let result=if enabled {match open_output(id.as_deref()){Ok(n)=>{native=Some(n);Ok(())},Err(e)=>Err(e)}}else{Ok(())};
                    let _=system.send(SystemMessage::KeyboardReady{request,enabled,result});
                },
                Ok(OutputControl::Reconnect)=>{release(&mut native,&mut held);native=None;match open_output(id.as_deref()){Ok(output)=>native=Some(output),Err(error)=>{let _=system.send(SystemMessage::OutputError{destination:destination.clone(),error});}}},
                Ok(OutputControl::Shutdown)|Err(_)=>break,
            },
            recv(events)->message=>{
                let Ok((epoch,action))=message else {break;};
                if epoch!=generation.load(Ordering::Acquire){continue;}
                // Flush any in-flight older generation before delivering a newer event.
                if epoch!=local_generation{release(&mut native,&mut held);local_generation=epoch;}
                let actions=match action {OutputAction::Chord{hid,modifiers,velocity}=>crate::qwerty::chord(hid,&modifiers,velocity),other=>vec![other]};
                for action in actions {if epoch!=generation.load(Ordering::Acquire){release(&mut native,&mut held);break;}
                if let Some(output)=native.as_mut(){
                    match output.write(&action){
                        Ok(())=>{match action {
                            OutputAction::Key{hid,down}=>{if down{held.insert((0,hid,0),OutputAction::Key{hid,down:false});}else{held.remove(&(0,hid,0));}},
                            OutputAction::Midi{id,event}=>{let key=(event.channel(),event.data1 as u16,if event.kind()==0xb0{0xb0}else{0x90});if event.kind()==0x90{held.insert(key,OutputAction::Midi{id,event:MidiEvent::note_off(event.channel(),event.data1)});}else if event.kind()==0x80{held.remove(&key);}else if event.kind()==0xb0 && matches!(event.data1,64|66){if event.data2>=64{held.insert(key,OutputAction::Midi{id,event:MidiEvent::cc(event.channel(),event.data1,0)});}else{held.remove(&key);}}},
                            _=>{}
                        }},
                        Err(error)=>{let _=system.send(SystemMessage::OutputError{destination:destination.clone(),error});fault.store(true,Ordering::Release);release(&mut native,&mut held);native=None;}
                    }
                }
                }
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
) {
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
    loop {
        let timeout = if active {
            next.saturating_duration_since(Instant::now())
        } else {
            Duration::from_secs(3600)
        };
        match commands.recv_timeout(timeout) {
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
                        match s.read(selected) {
                            Ok(values) => {
                                if events
                                    .try_send(InputMessage::Analog {
                                        values: Box::new(values),
                                        generation: generation.load(Ordering::Acquire),
                                        received: Instant::now(),
                                    })
                                    .is_err()
                                {
                                    fault.store(true, Ordering::Release);
                                }
                            }
                            Err(error) => {
                                active = false;
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

fn run(commands: Receiver<Request>, shared: Arc<RwLock<Snapshot>>, stopped: Arc<AtomicBool>) {
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
        thread::spawn(move || analog_worker(analog_rx, tx, sys, gen, fault))
    };
    let mut keyboard = OutputHandle::new(None, system_tx.clone(), fault.clone());
    let mut outputs: HashMap<String, OutputHandle> = HashMap::new();
    let (mut keyboard_request, mut analog_request) = (0u64, 0u64);
    let mut live_notes: HashSet<(Source, u8, u8)> = HashSet::new();
    let mut input_barrier = Instant::now();
    let mut next_snapshot = Instant::now();
    let mut rate = 0u32;
    let mut rate_start = Instant::now();
    macro_rules! dispatch {
        ($actions:expr) => {
            for action in $actions {
                match &action {
                    OutputAction::Key { .. } | OutputAction::Chord { .. } => {
                        keyboard.send(action, &fault)
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
            .or_insert_with(|| OutputHandle::new(Some(id), system_tx.clone(), fault.clone()));
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
            state.qwerty_enabled = false;
            state.qwerty_pending = false;
            keyboard_request += 1;
            keyboard.flush();
            let _ = keyboard.control.send(OutputControl::Enable {
                enabled: false,
                request: keyboard_request,
            });
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
                            flush!();disarm!();if !keep_analog{disable_analog!();}let mode_changed=settings.input_mode!=state.settings.input_mode;
                            state.settings=settings;state.revision+=1;state.sdk_found=crate::analog::find_sdk(state.settings.sdk_path.as_deref());
                            let _=device_tx.send(DeviceCommand::Select(state.settings.preferred_midi.clone()));
                            if mode_changed{state.paused=false;}
                            let desired:HashSet<String>=state.settings.profile().routes.iter().filter(|r|r.enabled).filter_map(|r|if let Destination::Midi(id)=&r.destination{Some(id.clone())}else{None}).collect();
                            let removed:Vec<_>=outputs.keys().filter(|id|!desired.contains(*id)).cloned().collect();for id in removed{if let Some(mut out)=outputs.remove(&id){out.stop();}}
                            for id in desired{if let Some(out)=outputs.get(&id){let _=out.control.send(OutputControl::Reconnect);}else{outputs.insert(id.clone(),OutputHandle::new(Some(id),system_tx.clone(),fault.clone()));}}
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
                    Command::Pause{paused}=>{flush!();state.paused=paused;},
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
                if shutdown {engine.flush();keyboard.flush();for out in outputs.values(){out.flush();}disarm!();disable_analog!();sequencer.stop();let _=device_tx.send(DeviceCommand::Shutdown);let _=analog_tx.send(AnalogCommand::Shutdown);let _=device_join.join();let _=analog_join.join();keyboard.stop();for out in outputs.values_mut(){out.stop();}stopped.store(true,Ordering::Release);if let Some((reply,_))=reply.take(){let _=reply.send(Ok(state.clone()));}break;}
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
                    if !state.settings.profile().routes.iter().any(|r|r.source==source&&matches!(r.destination,Destination::Recorder(_))){sequencer.record(event,received);}dispatch!(engine.process(source,event,state.settings.profile(),state.qwerty_enabled,state.paused));},
                    InputMessage::Analog{values,generation,received}=>if received>=input_barrier&&state.analog_enabled&&generation==analog_generation.load(Ordering::Acquire){for event in analog.process(&values,&state.settings.profile().analog,state.settings.aftertouch,received){let source=Source::Analog;state.last_event=Some(event);state.received+=1;if event.kind()==0x90{live_notes.insert((source,event.channel(),event.data1));}else if event.kind()==0x80{live_notes.remove(&(source,event.channel(),event.data1));}
                    if !state.settings.profile().routes.iter().any(|r|r.source==Source::Analog&&matches!(r.destination,Destination::Recorder(_))){sequencer.record(event,received);}dispatch!(engine.process(Source::Analog,event,state.settings.profile(),state.qwerty_enabled,state.paused));}},
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

#[cfg(test)]
mod tests {
    use super::*;
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
            .all(|(epoch, _)| epoch != generation.load(Ordering::Acquire)));
    }
}
