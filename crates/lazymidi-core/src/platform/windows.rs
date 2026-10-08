use super::key_codes;
use crate::Result;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

#[cfg(feature = "wooting")]
pub(crate) struct PollTimer(windows_sys::Win32::Foundation::HANDLE);
#[cfg(feature = "wooting")]
impl PollTimer {
    pub fn new() -> Result<Self> {
        use windows_sys::Win32::System::Threading::*;
        // SAFETY: unnamed, non-inheritable timer, owned by this worker only.
        let handle = unsafe {
            CreateWaitableTimerExW(
                std::ptr::null(),
                std::ptr::null(),
                CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                TIMER_ALL_ACCESS,
            )
        };
        if handle.is_null() {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(Self(handle))
        }
    }

    pub fn wait(&self, duration: std::time::Duration) -> Result<()> {
        use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::*};
        if duration.is_zero() {
            return Ok(());
        }
        let due = -(duration.as_nanos().div_ceil(100).min(i64::MAX as u128) as i64);
        // SAFETY: live handle and initialized relative due time; no callbacks.
        let armed = unsafe { SetWaitableTimer(self.0, &due, 0, None, std::ptr::null(), 0) };
        if armed == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: this worker owns the timer; finite wait bounds failures.
        if unsafe { WaitForSingleObject(self.0, 1000) } != WAIT_OBJECT_0 {
            return Err("Analog polling timer failed.".into());
        }
        Ok(())
    }
}
#[cfg(feature = "wooting")]
impl Drop for PollTimer {
    fn drop(&mut self) {
        // SAFETY: the worker has finished waiting and owns this handle exactly once.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(all(test, feature = "wooting"))]
mod timing_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    #[ignore = "Windows scheduling measurement; run explicitly on release hardware"]
    fn analog_polling_deadlines() {
        let timer = PollTimer::new().unwrap();
        for hz in [250, 500, 1000] {
            let period = Duration::from_secs_f64(1.0 / hz as f64);
            let mut next = Instant::now();
            let mut last = next;
            let mut gaps = Vec::new();
            let mut late = Vec::new();
            for i in 0..1000 {
                timer
                    .wait(next.saturating_duration_since(Instant::now()))
                    .unwrap();
                let now = Instant::now();
                if i > 0 {
                    gaps.push(now.duration_since(last).as_nanos());
                    late.push(now.saturating_duration_since(next).as_nanos());
                }
                last = now;
                next += period;
                if next < Instant::now() {
                    next = Instant::now() + period;
                }
            }
            gaps.sort_unstable();
            late.sort_unstable();
            println!("High-resolution poll {hz}Hz: gap p50={:.3}ms p99={:.3}ms; wake lateness p99={:.3}ms", gaps[499] as f64 / 1e6, gaps[989] as f64 / 1e6, late[989] as f64 / 1e6);
            assert!(
                gaps[499] < 8_000_000,
                "Polling still has the old ~15ms delay"
            );
        }
    }
}

pub struct Keyboard;
impl Keyboard {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
    pub fn write(&mut self, hid: u16, down: bool) -> Result<()> {
        self.write_many(&[(hid, down)])
    }
    pub fn write_many(&mut self, keys: &[(u16, bool)]) -> Result<()> {
        let inputs = keys
            .iter()
            .map(|&(hid, down)| keyboard_input(hid, down))
            .collect::<Result<Vec<_>>>()?;
        if inputs.is_empty() {
            return Ok(());
        }
        // SAFETY: validated initialized INPUTs and their exact ABI size; bounded by the output worker.
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if sent as usize != inputs.len() {
            return Err(format!(
                "Windows accepted {sent}/{} keyboard events: {}. Elevated targets may block input.",
                inputs.len(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}
fn keyboard_input(hid: u16, down: bool) -> Result<INPUT> {
    let (code, _) = key_codes(hid)?;
    Ok(INPUT {
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
    })
}

#[cfg(test)]
mod input_tests {
    use super::*;
    #[test]
    fn batches_validate_every_key_before_injection_and_keep_scan_flags() {
        assert!(Keyboard::new()
            .unwrap()
            .write_many(&[(4, true), (65535, true)])
            .is_err());
        let input = keyboard_input(228, false).unwrap();
        // SAFETY: keyboard_input sets the INPUT_KEYBOARD union variant.
        let key = unsafe { input.Anonymous.ki };
        assert_eq!(key.wScan, 0x1d);
        assert_eq!(
            key.dwFlags,
            KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP
        );
    }
}
