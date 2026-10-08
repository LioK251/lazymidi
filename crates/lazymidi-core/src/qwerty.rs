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
