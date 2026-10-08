use crate::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "track", rename_all = "snake_case")]
pub enum Source {
    Midi,
    Analog,
    Sequencer(u8),
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Destination {
    Qwerty,
    Midi(String),
    Recorder(u8),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Route {
    pub id: String,
    pub source: Source,
    pub destination: Destination,
    pub enabled: bool,
    pub channel: Option<u8>,
    pub remap_channel: Option<u8>,
}
impl Route {
    pub fn defaults() -> Vec<Self> {
        [Source::Midi, Source::Analog]
            .into_iter()
            .enumerate()
            .map(|(i, source)| Self {
                id: format!("live-{i}"),
                source,
                destination: Destination::Qwerty,
                enabled: true,
                channel: None,
                remap_channel: None,
            })
            .collect()
    }
}
pub fn validate(routes: &[Route]) -> Result<()> {
    if routes.len() > 128 {
        return Err("At most 128 routes are supported.".into());
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for r in routes {
        if r.id.is_empty() || r.id.len() > 128 || !ids.insert(&r.id) {
            return Err("Route IDs must be unique and nonempty.".into());
        }
        if r.channel.is_some_and(|c| c > 15) || r.remap_channel.is_some_and(|c| c > 15) {
            return Err("Route channels must be 1–16.".into());
        }
        if matches!(r.source,Source::Sequencer(t) if t>3)
            || matches!(r.destination,Destination::Recorder(t) if t>3)
        {
            return Err("Track must be 1–4.".into());
        }
        // The fixed source/sink model is acyclic. Recorder feedback is excluded entirely in V1.
        if matches!(r.source, Source::Sequencer(_))
            && matches!(r.destination, Destination::Recorder(_))
        {
            return Err("Sequencer playback cannot feed a recorder.".into());
        }
        if let Destination::Midi(id) = &r.destination {
            if id.is_empty() || id.len() > 1024 {
                return Err("Invalid MIDI output ID.".into());
            }
        }
        if !paths.insert((r.source, &r.destination, r.channel, r.remap_channel)) {
            return Err("Duplicate routes would deliver the same signal twice.".into());
        }
    }
    Ok(())
}
