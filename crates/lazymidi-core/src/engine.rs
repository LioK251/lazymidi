use crate::{
    config::Profile,
    midi::MidiEvent,
    routing::{Destination, Source},
    Result,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutputAction {
    Key {
        hid: u16,
        down: bool,
    },
    Chord {
        hid: u16,
        modifiers: Vec<u16>,
        velocity: Option<u8>,
    },
    Midi {
        id: String,
        event: MidiEvent,
    },
    Record {
        track: u8,
        event: MidiEvent,
    },
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct Owner {
    source: Source,
    route: String,
    channel: u8,
    note: u8,
    kind: u8,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
enum Held {
    Key(u16),
    Note(String, u8, u8),
    Pedal(String, u8, u8),
}
#[derive(Default)]
pub struct Engine {
    owners: HashMap<Owner, Held>,
    counts: HashMap<Held, u32>,
}
impl Held {
    fn release(&self) -> OutputAction {
        match self {
            Self::Key(hid) => OutputAction::Key {
                hid: *hid,
                down: false,
            },
            Self::Note(id, c, n) => OutputAction::Midi {
                id: id.clone(),
                event: MidiEvent::note_off(*c, *n),
            },
            Self::Pedal(id, c, cc) => OutputAction::Midi {
                id: id.clone(),
                event: MidiEvent::cc(*c, *cc, 0),
            },
        }
    }
}
impl Engine {
    pub fn active_notes(&self) -> Vec<(Source, u8, u8)> {
        let mut values: Vec<_> = self
            .owners
            .keys()
            .filter(|o| o.kind == 0x90)
            .map(|o| (o.source, o.channel, o.note))
            .collect();
        values.sort_by_key(|v| (v.1, v.2));
        values.dedup();
        values
    }
    fn release(&mut self, owner: &Owner) -> Vec<OutputAction> {
        if let Some(held) = self.owners.remove(owner) {
            let count = self.counts.entry(held.clone()).or_default();
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.counts.remove(&held);
                return vec![held.release()];
            }
        }
        vec![]
    }
    pub fn flush_source(&mut self, source: Source) -> Vec<OutputAction> {
        let owners: Vec<_> = self
            .owners
            .keys()
            .filter(|o| o.source == source)
            .cloned()
            .collect();
        owners.iter().flat_map(|o| self.release(o)).collect()
    }
    pub fn flush(&mut self) -> Vec<OutputAction> {
        let output = self.counts.keys().map(Held::release).collect();
        self.owners.clear();
        self.counts.clear();
        output
    }
    pub fn flush_qwerty(&mut self) -> Vec<OutputAction> {
        let owners: Vec<_> = self
            .owners
            .iter()
            .filter(|(_, held)| matches!(held, Held::Key(_)))
            .map(|(owner, _)| owner.clone())
            .collect();
        owners
            .iter()
            .flat_map(|owner| self.release(owner))
            .collect()
    }
    pub fn process(
        &mut self,
        source: Source,
        event: MidiEvent,
        profile: &Profile,
        qwerty: bool,
        paused: bool,
    ) -> Vec<OutputAction> {
        if event.kind() == 0xb0 && matches!(event.data1, 120 | 123) {
            return self.flush_source(source);
        }
        let mut output = Vec::new();
        let mut delivered = HashSet::new();
        for route in &profile.routes {
            if !route.enabled
                || route.source != source
                || route.channel.is_some_and(|c| c != event.channel())
            {
                continue;
            }
            let mut mapped = event;
            if let Some(c) = route.remap_channel {
                mapped.status = mapped.kind() | c;
            }
            if !delivered.insert((route.destination.clone(), mapped.channel())) {
                continue;
            }
            match &route.destination {
                Destination::Recorder(track) => {
                    output.push(OutputAction::Record {
                        track: *track,
                        event: mapped,
                    });
                    continue;
                }
                Destination::Qwerty if !qwerty || paused => continue,
                _ => {}
            }
            let pedal = event.kind() == 0xb0 && matches!(event.data1, 64 | 66);
            let owner = Owner {
                source,
                route: route.id.clone(),
                channel: event.channel(),
                note: event.data1,
                kind: if pedal { 0xb0 } else { 0x90 },
            };
            if event.kind() == 0x80 || pedal && event.data2 < 64 {
                output.extend(self.release(&owner));
                continue;
            }
            let held = match &route.destination {
                Destination::Qwerty => {
                    if pedal {
                        if event.data1 == 64 && !profile.sustain_enabled {
                            continue;
                        }
                        let hid = if event.data1 == 64 {
                            profile.sustain_hid
                        } else {
                            profile.sostenuto_hid
                        };
                        let Some(hid) = hid else {
                            continue;
                        };
                        Held::Key(hid)
                    } else {
                        if event.kind() != 0x90 {
                            continue;
                        }
                        if !profile.extended_keys && !(36..=96).contains(&mapped.data1) {
                            continue;
                        }
                        let Some(binding) = profile
                            .qwerty
                            .iter()
                            .find(|b| b.channel == mapped.channel() && b.note == mapped.data1)
                        else {
                            continue;
                        };
                        Held::Key(binding.hid)
                    }
                }
                Destination::Midi(id) => {
                    if pedal {
                        Held::Pedal(id.clone(), mapped.channel(), mapped.data1)
                    } else if event.kind() == 0x90 {
                        Held::Note(id.clone(), mapped.channel(), mapped.data1)
                    } else {
                        output.push(OutputAction::Midi {
                            id: id.clone(),
                            event: mapped,
                        });
                        continue;
                    }
                }
                Destination::Recorder(_) => continue,
            };
            if self.owners.contains_key(&owner) {
                if pedal {
                    continue;
                }
                output.extend(self.release(&owner));
            }
            let count = self.counts.entry(held.clone()).or_default();
            let first = *count == 0;
            *count += 1;
            self.owners.insert(owner, held.clone());
            if first || (profile.visual_pianos && matches!(held, Held::Key(_)) && !pedal) {
                match held {
                    Held::Key(hid) => {
                        if pedal {
                            output.push(OutputAction::Key { hid, down: true });
                        } else {
                            let binding = profile
                                .qwerty
                                .iter()
                                .find(|b| b.channel == mapped.channel() && b.note == mapped.data1)
                                .expect("binding selected above");
                            if profile.visual_pianos || !binding.modifiers.is_empty() {
                                output.push(OutputAction::Chord {
                                    hid,
                                    modifiers: binding.modifiers.clone(),
                                    velocity: (profile.visual_pianos && profile.game_velocity)
                                        .then_some(mapped.data2),
                                });
                            } else {
                                output.push(OutputAction::Key { hid, down: true });
                            }
                        }
                    }
                    Held::Note(id, _, _) | Held::Pedal(id, _, _) => {
                        output.push(OutputAction::Midi { id, event: mapped })
                    }
                }
            }
        }
        output
    }
}
pub fn validate_profile(profile: &Profile) -> Result<()> {
    profile.validate()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owners_prevent_early_key_release() {
        let p = Profile::default();
        let mut e = Engine::default();
        assert_eq!(
            e.process(
                Source::Midi,
                MidiEvent::note_on(0, 36, 100),
                &p,
                true,
                false
            ),
            vec![OutputAction::Key {
                hid: 30,
                down: true
            }]
        );
        assert!(e
            .process(
                Source::Analog,
                MidiEvent::note_on(0, 36, 50),
                &p,
                true,
                false
            )
            .is_empty());
        assert!(e.flush_source(Source::Midi).is_empty());
        assert_eq!(
            e.flush(),
            vec![OutputAction::Key {
                hid: 30,
                down: false
            }]
        );
        assert!(e.flush().is_empty());
    }
    #[test]
    fn remapped_note_and_pedal_release() {
        let p = Profile {
            routes: vec![crate::routing::Route {
                id: "output".into(),
                source: Source::Midi,
                destination: Destination::Midi("out".into()),
                enabled: true,
                channel: None,
                remap_channel: Some(2),
            }],
            ..Profile::default()
        };
        let mut e = Engine::default();
        e.process(
            Source::Midi,
            MidiEvent::note_on(0, 60, 80),
            &p,
            false,
            false,
        );
        e.process(Source::Midi, MidiEvent::cc(0, 64, 127), &p, false, false);
        let released = e.flush();
        assert!(released.contains(&OutputAction::Midi {
            id: "out".into(),
            event: MidiEvent::note_off(2, 60)
        }));
        assert!(released.contains(&OutputAction::Midi {
            id: "out".into(),
            event: MidiEvent::cc(2, 64, 0)
        }));
    }
}
