use super::key_codes;
use crate::Result;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

pub struct Keyboard;
impl Keyboard {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
    pub fn write(&mut self, hid: u16, down: bool) -> Result<()> {
        let (code, _) = key_codes(hid)?;
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: 0,
                    wScan: code & 0xff,
                    dwFlags: KEYEVENTF_SCANCODE
                        | if code > 255 { KEYEVENTF_EXTENDEDKEY } else { 0 }
                        | if down { 0 } else { KEYEVENTF_KEYUP },
                    time: 0,
                    dwExtraInfo: 0x4c415a59,
                },
            },
        };
        // SAFETY: one initialized INPUT, its exact ABI size and a live pointer.
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) };
        if sent != 1 {
            return Err(format!(
                "Windows did not accept keyboard output: {}. Elevated targets may block input.",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}
