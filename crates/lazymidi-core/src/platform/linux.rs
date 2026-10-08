use crate::Result;
use evdev::{uinput::VirtualDevice, AttributeSet, EventType, InputEvent, KeyCode};
pub struct Keyboard {
    device: VirtualDevice,
}
impl Keyboard {
    pub fn new() -> Result<Self> {
        let keys: AttributeSet<KeyCode> = super::KEYS
            .iter()
            .map(|k| KeyCode::new(linux_code(k.0, k.1)))
            .collect();
        let device=VirtualDevice::builder().map_err(|e|format!("Cannot open /dev/uinput: {e}. Configure device access; do not run lazymidi as root."))?
            .name("lazymidi keyboard").with_keys(&keys).map_err(|e|e.to_string())?.build().map_err(|e|e.to_string())?;
        Ok(Self { device })
    }
    pub fn write(&mut self, hid: u16, down: bool) -> Result<()> {
        let (code, _) = super::key_codes(hid)?;
        self.device
            .emit(&[InputEvent::new(
                EventType::KEY.0,
                linux_code(hid, code),
                i32::from(down),
            )])
            .map_err(|e| e.to_string())
    }
}
fn linux_code(hid: u16, scan: u16) -> u16 {
    match hid {
        73 => 110,
        74 => 102,
        75 => 104,
        76 => 111,
        77 => 107,
        78 => 109,
        79 => 106,
        80 => 105,
        81 => 108,
        82 => 103,
        84 => 98,
        88 => 96,
        227 => 125,
        228 => 97,
        230 => 100,
        231 => 126,
        _ => scan,
    }
}
