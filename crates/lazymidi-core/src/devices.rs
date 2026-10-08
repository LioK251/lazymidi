use crate::{
    midi::MidiEvent,
    routing::Source,
    runtime::{InputMessage, SystemMessage},
    Result,
};
use crossbeam_channel::{Receiver, Sender};
use midir::{MidiInput, MidiInputConnection, MidiOutput};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
}
pub enum DeviceCommand {
    Select(Option<String>),
    Refresh,
    Shutdown,
}
pub fn choose_input(preferred: Option<&str>, devices: &[Device]) -> Option<String> {
    if let Some(id) = preferred {
        let matches: Vec<_> = devices.iter().filter(|d| d.id == id).collect();
        return (matches.len() == 1).then(|| matches[0].id.clone());
    }
    if devices.len() == 1 {
        Some(devices[0].id.clone())
    } else {
        None
    }
}
fn input_devices(input: &MidiInput) -> Vec<Device> {
    input
        .ports()
        .iter()
        .filter_map(|p| {
            input
                .port_name(p)
                .ok()
                .filter(|name| !name.contains("lazymidi Output"))
                .map(|name| Device { id: p.id(), name })
        })
        .collect()
}
pub fn output_devices() -> Result<Vec<Device>> {
    let midi = MidiOutput::new("lazymidi discovery").map_err(|e| e.to_string())?;
    Ok(midi
        .ports()
        .iter()
        .filter_map(|p| {
            midi.port_name(p)
                .ok()
                .map(|name| Device { id: p.id(), name })
        })
        .collect())
}
pub fn run(
    commands: Receiver<DeviceCommand>,
    events: Sender<InputMessage>,
    system: Sender<SystemMessage>,
    generation: Arc<AtomicU64>,
    fault: Arc<AtomicBool>,
    mut preferred: Option<String>,
) {
    let mut connection: Option<MidiInputConnection<()>> = None;
    let mut connected: Option<String> = None;
    let mut last_devices = Vec::new();
    let mut last_outputs = Vec::new();
    let mut first = true;
    let mut next = Instant::now();
    let mut force = false;
    loop {
        if Instant::now() >= next || force {
            next = Instant::now() + Duration::from_secs(1);
            force = false;
            let input = match MidiInput::new("lazymidi input") {
                Ok(v) => v,
                Err(e) => {
                    let _ = system.send(SystemMessage::Warning(format!("MIDI discovery: {e}")));
                    match commands.recv_timeout(Duration::from_secs(1)) {
                        Ok(DeviceCommand::Shutdown)
                        | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                        Ok(DeviceCommand::Select(p)) => preferred = p,
                        _ => {}
                    }
                    continue;
                }
            };
            let devices = input_devices(&input);
            let outputs = output_devices().unwrap_or_default();
            if first || devices != last_devices || outputs != last_outputs {
                let _ = system.send(SystemMessage::Devices {
                    inputs: devices.clone(),
                    outputs: outputs.clone(),
                });
                last_devices = devices.clone();
                last_outputs = outputs;
                first = false;
            }
            let selected = choose_input(preferred.as_deref(), &devices);
            if preferred.is_none() && selected.is_some() {
                preferred = selected.clone();
            }
            if selected != connected {
                generation.fetch_add(1, Ordering::SeqCst);
                connection.take();
                connected = None;
                let _ = system.send(SystemMessage::MidiConnection {
                    device: None,
                    error: None,
                });
                if let Some(id) = selected {
                    if let Some(port) = input.find_port_by_id(&id) {
                        let tx = events.clone();
                        let generation_number = generation.load(Ordering::SeqCst);
                        let fault = fault.clone();
                        match input.connect(
                            &port,
                            "lazymidi capture",
                            move |_, bytes, _| {
                                if let Some(event) = MidiEvent::parse(bytes) {
                                    if tx
                                        .try_send(InputMessage::Midi {
                                            source: Source::Midi,
                                            event,
                                            generation: generation_number,
                                            received: Instant::now(),
                                        })
                                        .is_err()
                                    {
                                        fault.store(true, Ordering::Release);
                                    }
                                }
                            },
                            (),
                        ) {
                            Ok(c) => {
                                connection = Some(c);
                                connected = Some(id.clone());
                                let _ = system.send(SystemMessage::MidiConnection {
                                    device: Some(id),
                                    error: None,
                                });
                            }
                            Err(e) => {
                                let _ = system.send(SystemMessage::MidiConnection {
                                    device: None,
                                    error: Some(format!("Cannot connect MIDI input: {e}")),
                                });
                            }
                        }
                    }
                }
            }
        }
        match commands.recv_timeout(next.saturating_duration_since(Instant::now())) {
            Ok(DeviceCommand::Select(p)) => {
                preferred = p;
                force = true;
            }
            Ok(DeviceCommand::Refresh) => force = true,
            Ok(DeviceCommand::Shutdown)
            | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
        }
    }
    generation.fetch_add(1, Ordering::SeqCst);
    drop(connection);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unambiguous_selection() {
        let a = Device {
            id: "a".into(),
            name: "Piano".into(),
        };
        let b = Device {
            id: "b".into(),
            name: "Piano".into(),
        };
        assert_eq!(
            choose_input(None, std::slice::from_ref(&a)),
            Some("a".into())
        );
        assert_eq!(choose_input(None, &[a.clone(), b.clone()]), None);
        assert_eq!(
            choose_input(Some("missing"), std::slice::from_ref(&a)),
            None
        );
        assert_eq!(choose_input(Some("b"), &[a, b]), Some("b".into()));
    }
}
