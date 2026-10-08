use crate::Result;

#[cfg(all(windows, feature = "wooting"))]
pub(crate) use windows::PollTimer;

// Physical HID usages, OS scan codes and CGKeyCodes; alphabet/digit translations adapted
// from ArijanJ/miditoqwerty-rs (MIT), extended with correct Windows E0 handling.
const KEYS: &[(u16, u16, u16)] = &[
    (4, 30, 0),
    (5, 48, 11),
    (6, 46, 8),
    (7, 32, 2),
    (8, 18, 14),
    (9, 33, 3),
    (10, 34, 5),
    (11, 35, 4),
    (12, 23, 34),
    (13, 36, 38),
    (14, 37, 40),
    (15, 38, 37),
    (16, 50, 46),
    (17, 49, 45),
    (18, 24, 31),
    (19, 25, 35),
    (20, 16, 12),
    (21, 19, 15),
    (22, 31, 1),
    (23, 20, 17),
    (24, 22, 32),
    (25, 47, 9),
    (26, 17, 13),
    (27, 45, 7),
    (28, 21, 16),
    (29, 44, 6),
    (30, 2, 18),
    (31, 3, 19),
    (32, 4, 20),
    (33, 5, 21),
    (34, 6, 23),
    (35, 7, 22),
    (36, 8, 26),
    (37, 9, 28),
    (38, 10, 25),
    (39, 11, 29),
    (40, 28, 36),
    (41, 1, 53),
    (42, 14, 51),
    (43, 15, 48),
    (44, 57, 49),
    (45, 12, 27),
    (46, 13, 24),
    (47, 26, 33),
    (48, 27, 30),
    (49, 43, 42),
    (51, 39, 41),
    (52, 40, 39),
    (53, 41, 50),
    (54, 51, 43),
    (55, 52, 47),
    (56, 53, 44),
    (57, 58, 57),
    (58, 59, 122),
    (59, 60, 120),
    (60, 61, 99),
    (61, 62, 118),
    (62, 63, 96),
    (63, 64, 97),
    (64, 65, 98),
    (65, 66, 100),
    (66, 67, 101),
    (67, 68, 109),
    (68, 87, 103),
    (69, 88, 111),
    (73, 0x152, 114),
    (74, 0x147, 115),
    (75, 0x149, 116),
    (76, 0x153, 117),
    (77, 0x14f, 119),
    (78, 0x151, 121),
    (79, 0x14d, 124),
    (80, 0x14b, 123),
    (81, 0x150, 125),
    (82, 0x148, 126),
    (84, 0x135, 75),
    (85, 55, 67),
    (86, 74, 78),
    (87, 78, 69),
    (88, 0x11c, 76),
    (89, 79, 83),
    (90, 80, 84),
    (91, 81, 85),
    (92, 75, 86),
    (93, 76, 87),
    (94, 77, 88),
    (95, 71, 89),
    (96, 72, 91),
    (97, 73, 92),
    (98, 82, 82),
    (99, 83, 65),
    (224, 29, 59),
    (225, 42, 56),
    (226, 56, 58),
    (227, 0x15b, 55),
    (228, 0x11d, 62),
    (229, 54, 60),
    (230, 0x138, 61),
    (231, 0x15c, 54),
];
pub fn key_supported(hid: u16) -> bool {
    KEYS.iter().any(|k| k.0 == hid)
}
fn key_codes(hid: u16) -> Result<(u16, u16)> {
    KEYS.iter()
        .find(|k| k.0 == hid)
        .map(|k| (k.1, k.2))
        .ok_or_else(|| format!("Unsupported HID usage {hid}."))
}
pub fn key_label(hid: u16) -> String {
    if (4..=29).contains(&hid) {
        return char::from(b'A' + (hid - 4) as u8).to_string();
    }
    if (30..=38).contains(&hid) {
        return (hid - 29).to_string();
    }
    match hid {
        39 => "0".into(),
        40 => "Enter".into(),
        41 => "Escape".into(),
        42 => "Backspace".into(),
        43 => "Tab".into(),
        44 => "Space".into(),
        225 => "Left Shift".into(),
        _ => format!("HID {hid}"),
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
pub use linux::Keyboard;
#[cfg(target_os = "macos")]
pub use macos::Keyboard;
#[cfg(windows)]
pub use windows::Keyboard;

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub struct Keyboard;
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
impl Keyboard {
    pub fn new() -> Result<Self> {
        Err("Keyboard output is unsupported on this OS.".into())
    }
    pub fn write(&mut self, _hid: u16, _down: bool) -> Result<()> {
        Err("Unsupported OS.".into())
    }
}

pub fn backend_name() -> &'static str {
    if cfg!(windows) {
        "Windows SendInput"
    } else if cfg!(target_os = "linux") {
        "Linux uinput"
    } else {
        "macOS CoreGraphics"
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_key_table() {
        for hid in 4..=39 {
            assert!(key_supported(hid));
        }
        assert_eq!(key_codes(30).unwrap(), (2, 18));
        assert!(!key_supported(65535));
    }
}
