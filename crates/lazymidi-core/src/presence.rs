use crate::runtime::{Snapshot, SystemMessage};
use crossbeam_channel::{Receiver, Sender};
use discord_rich_presence::{
    activity::{Activity, Button},
    DiscordIpc, DiscordIpcClient,
};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub struct Presence {
    pub enabled: bool,
    pub button: bool,
    pub details: String,
}
impl Presence {
    pub fn from_snapshot(state: &Snapshot) -> Self {
        let mut sources = Vec::new();
        if state.analog_enabled {
            if let Some(device) = state
                .analog_devices
                .iter()
                .find(|d| Some(&d.id) == state.analog_connected.as_ref())
            {
                sources.push(device.name.clone());
            }
        }
        if state.midi_connected.is_some()
            && (state.settings.both_inputs
                || state.settings.input_mode == crate::config::InputMode::Midi)
        {
            sources.push("MIDI".into());
        }
        Self {
            enabled: state.settings.discord_presence,
            button: state.settings.discord_get_button,
            details: if sources.is_empty() {
                "Ready".into()
            } else {
                format!("Playing: {}", sources.join(" + "))
            },
        }
    }
}
pub fn worker(updates: Receiver<Presence>, system: Sender<SystemMessage>) {
    let mut client = DiscordIpcClient::new("1558322430781563022");
    let mut connected = false;
    let mut desired: Option<Presence> = None;
    let mut next = Instant::now();
    let mut reported = "";
    loop {
        match updates.recv_timeout(Duration::from_millis(250)) {
            Ok(update) => {
                desired = Some(update);
                for update in updates.try_iter() {
                    desired = Some(update);
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            Err(_) => {}
        }
        let Some(state) = desired.as_ref() else {
            continue;
        };
        if !state.enabled {
            if connected {
                let _ = client.clear_activity();
                let _ = client.close();
                client = DiscordIpcClient::new("1558322430781563022");
            }
            connected = false;
            if reported != "Off" {
                let _ = system.try_send(SystemMessage::Presence("Off".into()));
                reported = "Off";
            }
            continue;
        }
        if Instant::now() < next {
            continue;
        }
        next = Instant::now() + Duration::from_secs(5);
        if !connected {
            connected = client.connect().is_ok();
        }
        if connected {
            // Refresh also detects a closed pipe after Discord restarts.
            let mut activity = Activity::new().details(&state.details);
            if state.button {
                activity = activity.buttons(vec![Button::new(
                    "Get",
                    "https://github.com/LioK251/lazymidi",
                )]);
            }
            if client.set_activity(activity).is_err() {
                let _ = client.close();
                connected = false;
            }
        }
        let status = if connected {
            "Connected"
        } else {
            "Discord unavailable"
        };
        if reported != status {
            let _ = system.try_send(SystemMessage::Presence(status.into()));
            reported = status;
        }
    }
    if connected {
        let _ = client.clear_activity();
        let _ = client.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_connected_sources_and_no_private_content() {
        let mut state = Snapshot::new(crate::config::Settings::default(), None);
        assert_eq!(Presence::from_snapshot(&state).details, "Ready");
        state.settings.input_mode = crate::config::InputMode::Midi;
        state.midi_connected = Some("private port name".into());
        assert_eq!(Presence::from_snapshot(&state).details, "Playing: MIDI");
    }
    #[test]
    fn disabled_presence_reports_once_and_exits_without_discord() {
        let (updates, rx) = crossbeam_channel::bounded(1);
        let (system, status) = crossbeam_channel::unbounded();
        let join = std::thread::spawn(move || worker(rx, system));
        let state = Presence {
            enabled: false,
            button: true,
            details: "Ready".into(),
        };
        updates.send(state.clone()).unwrap();
        assert!(
            matches!(status.recv_timeout(Duration::from_secs(1)).unwrap(),SystemMessage::Presence(s) if s=="Off")
        );
        updates.send(state).unwrap();
        assert!(status.recv_timeout(Duration::from_millis(300)).is_err());
        drop(updates);
        join.join().unwrap();
    }
}
