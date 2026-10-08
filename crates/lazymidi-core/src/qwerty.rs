use crate::{config::KeyBinding, engine::OutputAction};

// MIT: adapted from ArijanJ/miditoqwerty-rs output_methods/pv.rs at 73e4d6b.
pub const VISUAL_PIANOS: &str = include_str!("../resources/presets/visual-pianos-qwerty.json");
pub fn visual_bindings() -> Vec<KeyBinding> {
    serde_json::from_str(VISUAL_PIANOS).expect("embedded Visual Pianos bindings are tested")
}
pub fn velocity_hid(velocity: u8) -> u16 {
    const KEYS: &[u8] = b"1234567890qwertyuiopasdfghjklzxc";
    let index = (0..32)
        .min_by_key(|i| {
            let value = if *i == 31 { 127 } else { (*i + 1) * 4 };
            (velocity as i32 - value).abs()
        })
        .unwrap_or(15);
    let key = KEYS[index as usize];
    if key.is_ascii_lowercase() {
        (key - b'a') as u16 + 4
    } else if key == b'0' {
        39
    } else {
        (key - b'1') as u16 + 30
    }
}
pub fn chord(hid: u16, modifiers: &[u16], velocity: Option<u8>) -> Vec<OutputAction> {
    let mut events = Vec::with_capacity(12);
    let mut key = |hid, down| events.push(OutputAction::Key { hid, down });
    if let Some(velocity) = velocity {
        let value = velocity_hid(velocity);
        key(226, true);
        key(value, false);
        key(value, true);
        key(value, false);
        key(226, false);
    }
    // Games inspect modifiers on key-down. Release them immediately so a held
    // black/extended note cannot turn the next ordinary note into another pitch.
    for &m in modifiers {
        key(m, true);
    }
    key(hid, false);
    key(hid, true);
    for &m in modifiers.iter().rev() {
        key(m, false);
    }
    events
}

pub(crate) fn keyboard_batch<'a>(
    actions: impl IntoIterator<Item = &'a OutputAction>,
) -> Vec<OutputAction> {
    let mut events = Vec::new();
    let mut last_velocity = None;
    for action in actions {
        match action {
            OutputAction::Chord {
                hid,
                modifiers,
                velocity,
            } => {
                let safe = !(224..=231).contains(hid)
                    && modifiers.iter().all(|m| matches!(m, 224 | 225 | 228 | 229));
                let value = velocity.map(velocity_hid);
                // Only an atomic native batch may share game velocity; never cache across sends.
                let command = if safe && value.is_some() && value == last_velocity {
                    None
                } else {
                    *velocity
                };
                events.extend(chord(*hid, modifiers, command));
                last_velocity = if safe { value } else { None };
            }
            other => {
                last_velocity = None;
                events.push(other.clone());
            }
        }
    }
    events
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    fn note(velocity: Option<u8>, modifiers: Vec<u16>) -> OutputAction {
        OutputAction::Chord {
            hid: 4,
            modifiers,
            velocity,
        }
    }
    #[test]
    fn changed_velocity_and_custom_actions_reset_batch_velocity() {
        let count = |actions: Vec<OutputAction>| {
            keyboard_batch(&actions)
                .iter()
                .filter(|a| {
                    **a == OutputAction::Key {
                        hid: 226,
                        down: true,
                    }
                })
                .count()
        };
        assert_eq!(
            count(vec![
                note(Some(99), vec![]),
                note(Some(100), vec![224, 225])
            ]),
            1
        );
        assert_eq!(
            count(vec![note(Some(100), vec![]), note(Some(64), vec![])]),
            2
        );
        assert_eq!(
            count(vec![
                note(Some(100), vec![]),
                note(None, vec![]),
                note(Some(100), vec![])
            ]),
            2
        );
        assert_eq!(
            count(vec![
                note(Some(100), vec![]),
                OutputAction::Key {
                    hid: 44,
                    down: true
                },
                note(Some(100), vec![])
            ]),
            2
        );
        assert_eq!(
            count(vec![note(Some(100), vec![227]), note(Some(100), vec![])]),
            2
        );
        assert_eq!(
            count(vec![note(Some(100), vec![226]), note(Some(100), vec![])]),
            3
        );
        assert_eq!(count(vec![note(Some(100), vec![])]), 1);
        assert_eq!(count(vec![note(Some(100), vec![])]), 1);
    }
    #[test]
    fn repeated_velocity_is_set_once_within_a_batch() {
        let actions: Vec<_> = (4..12)
            .map(|hid| OutputAction::Chord {
                hid,
                modifiers: vec![],
                velocity: Some(100),
            })
            .collect();
        let batch = keyboard_batch(&actions);
        assert_eq!(batch.len(), 21);
        assert_eq!(
            batch
                .iter()
                .filter(|a| **a
                    == OutputAction::Key {
                        hid: 226,
                        down: true
                    })
                .count(),
            1
        );
        assert_eq!(
            batch.last(),
            Some(&OutputAction::Key {
                hid: 11,
                down: true
            })
        );
    }
}
