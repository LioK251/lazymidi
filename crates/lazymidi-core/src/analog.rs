#[cfg(feature = "wooting")]
use crate::Result;
use crate::{config::AnalogPreset, midi::MidiEvent};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Debug, Serialize)]
pub struct AnalogDevice {
    pub id: String,
    pub name: String,
}
pub fn find_sdk(custom: Option<&Path>) -> Option<PathBuf> {
    let mut paths = Vec::new();
    if cfg!(windows) {
        paths.push(PathBuf::from(
            "C:/Program Files/wooting-analog-sdk/wooting_analog_sdk.dll",
        ));
    } else if cfg!(target_os = "macos") {
        paths.push(PathBuf::from("/usr/local/lib/libwooting_analog_sdk.dylib"));
    } else {
        paths.push(PathBuf::from("/usr/lib/libwooting_analog_sdk.so"));
        paths.push(PathBuf::from("/usr/local/lib/libwooting_analog_sdk.so"));
    }
    if let Some(p) = custom {
        if p.is_absolute() {
            paths.push(p.to_owned());
        }
    }
    paths.into_iter().find(|p| p.is_file())
}

#[derive(Default)]
struct KeyState {
    depth: f32,
    start: Option<(Instant, f32)>,
    notes: Vec<(u8, u8, u8)>,
    blocked: bool,
}
#[derive(Default)]
pub struct AnalogProcessor {
    keys: HashMap<u16, KeyState>,
    preset: Option<AnalogPreset>,
    bindings: HashMap<u16, Vec<(u8, u8)>>,
}
impl AnalogProcessor {
    pub fn reset(&mut self) -> Vec<MidiEvent> {
        let releases = self
            .keys
            .values()
            .flat_map(|k| k.notes.iter().map(|&(c, _, n)| MidiEvent::note_off(c, n)))
            .collect();
        for state in self.keys.values_mut() {
            state.notes.clear();
            state.blocked = state.depth > 0.0;
        }
        releases
    }
    pub fn process(
        &mut self,
        values: &[f32; 256],
        preset: &AnalogPreset,
        aftertouch: bool,
        now: Instant,
    ) -> Vec<MidiEvent> {
        let mut events = Vec::new();
        if self.preset.as_ref() != Some(preset) {
            self.bindings.clear();
            for (&channel, pairs) in &preset.keymapping {
                for &(hid, note) in pairs {
                    self.bindings.entry(hid).or_default().push((channel, note));
                }
            }
            self.preset = Some(preset.clone());
        }
        for (&hid, pairs) in &self.bindings {
            let depth = values[hid as usize];
            if !depth.is_finite() || !(0.0..=1.0).contains(&depth) {
                continue;
            }
            let state = self.keys.entry(hid).or_default();
            if state.blocked {
                state.depth = depth;
                if depth > preset.note_config.threshold {
                    continue;
                }
                state.blocked = false;
            }
            if depth <= preset.note_config.threshold {
                if state.depth == 0.0 && depth > 0.0 || depth == 0.0 || depth < state.depth - 0.01 {
                    state.start = Some((now, depth));
                }
                for (c, _, n) in state.notes.drain(..) {
                    events.push(MidiEvent::note_off(c, n));
                }
            } else {
                for &(channel, note) in pairs {
                    if !state
                        .notes
                        .iter()
                        .any(|&(c, base, _)| c == channel && base == note)
                    {
                        // Velocity model adapted from Wooting Analog MIDI (MIT): depth/time * scale/100.
                        let speed = state
                            .start
                            .map(|(start, previous)| {
                                (depth - previous).max(0.0)
                                    / now
                                        .saturating_duration_since(start)
                                        .as_secs_f32()
                                        .max(0.000001)
                            })
                            .unwrap_or(100.0);
                        let velocity = ((speed * preset.note_config.velocity_scale / 100.0)
                            .clamp(0.0, 1.0)
                            * 127.0)
                            .round()
                            .clamp(1.0, 127.0) as u8;
                        let shift = if values[225] >= 0.2 {
                            preset.shift_amount
                        } else {
                            0
                        };
                        let effective = note as i16 + shift;
                        if (0..=127).contains(&effective) {
                            events.push(MidiEvent::note_on(channel, effective as u8, velocity));
                            state.notes.push((channel, note, effective as u8));
                        }
                    } else if aftertouch && (depth - state.depth).abs() >= 1.0 / 127.0 {
                        for &(c, base, n) in &state.notes {
                            if c == channel && base == note {
                                events.push(MidiEvent {
                                    status: 0xa0 | c,
                                    data1: n,
                                    data2: (depth * 127.0).round() as u8,
                                });
                            }
                        }
                    }
                }
            }
            state.depth = depth;
        }
        events
    }
}

#[cfg(feature = "wooting")]
mod sdk {
    use super::*;
    use libloading::Library;
    use std::ffi::{c_char, CStr};
    // C ABI declarations independently expressed from the published SDK contract.
    #[repr(C)]
    struct DeviceInfo {
        vendor: u16,
        product: u16,
        manufacturer: *const c_char,
        name: *const c_char,
        id: u64,
        kind: i32,
    }
    type Init = unsafe extern "C" fn() -> i32;
    type Version = unsafe extern "C" fn() -> i32;
    type Semver = unsafe extern "C" fn() -> *const c_char;
    type Mode = unsafe extern "C" fn(u32) -> i32;
    type Devices = unsafe extern "C" fn(*mut *const DeviceInfo, u32) -> i32;
    type Read = unsafe extern "C" fn(*mut u16, *mut f32, u32, u64) -> i32;
    pub struct Sdk {
        library: Library,
        init: Init,
        uninit: Init,
        devices: Devices,
        read: Read,
        mode: Mode,
        version: Version,
        semver: Semver,
        active: bool,
        codes: [u16; 256],
        values: [f32; 256],
    }
    impl Sdk {
        pub fn load(path: &Path) -> Result<Self> {
            if !path.is_absolute() {
                return Err("SDK path must be absolute.".into());
            }
            // SAFETY: explicit user/known installation path. Symbols use the v0.9.1 C ABI;
            // functions cannot outlive the resident library and are called on one worker.
            unsafe {
                let library = Library::new(path)
                    .map_err(|e| format!("Cannot load installed SDK (check architecture): {e}"))?;
                macro_rules! symbol {
                    ($name:literal,$ty:ty) => {
                        *library
                            .get::<$ty>(concat!($name, "\0").as_bytes())
                            .map_err(|e| format!("SDK symbol missing: {e}"))?
                    };
                }
                let init = symbol!("wooting_analog_initialise", Init);
                let uninit = symbol!("wooting_analog_uninitialise", Init);
                let devices = symbol!("wooting_analog_get_connected_devices_info", Devices);
                let read = symbol!("wooting_analog_read_full_buffer_device", Read);
                let mode = symbol!("wooting_analog_set_keycode_mode", Mode);
                let version = symbol!("wooting_analog_version", Version);
                let semver = symbol!("wooting_analog_version_semver", Semver);
                if version() != 0 {
                    return Err(
                        "Installed SDK ABI is incompatible. Install a compatible 0.9.1 SDK.".into(),
                    );
                }
                let p = semver();
                if p.is_null() {
                    return Err("SDK version string is unavailable.".into());
                }
                let value = CStr::from_ptr(p).to_string_lossy();
                if !value.starts_with("0.9.") {
                    return Err(format!("SDK {value} is not qualified. Install SDK 0.9.1."));
                }
                Ok(Self {
                    library,
                    init,
                    uninit,
                    devices,
                    read,
                    mode,
                    version,
                    semver,
                    active: false,
                    codes: [0; 256],
                    values: [0.0; 256],
                })
            }
        }
        pub fn start(&mut self) -> Result<String> {
            // SAFETY: validated resident C ABI, worker-exclusive SDK state.
            unsafe {
                let count = (self.init)();
                if count < 0 {
                    return Err(format!("SDK initialization failed ({count}). Check installed SDK and device permissions."));
                }
                self.active = true;
                if (self.mode)(0) != 1 {
                    self.stop();
                    return Err("SDK HID mode is unavailable.".into());
                }
                Ok(CStr::from_ptr((self.semver)())
                    .to_string_lossy()
                    .into_owned())
            }
        }
        pub fn devices(&self) -> Result<Vec<AnalogDevice>> {
            let mut buffer = [std::ptr::null(); 32];
            // SAFETY: fixed output capacity; copy returned borrowed strings before another SDK call.
            unsafe {
                let count = (self.devices)(buffer.as_mut_ptr(), buffer.len() as u32);
                if count < 0 {
                    return Err(format!("Device enumeration failed ({count})."));
                }
                if count as usize > buffer.len() {
                    return Err("SDK returned an invalid device count.".into());
                }
                buffer[..count as usize]
                    .iter()
                    .filter(|p| !p.is_null())
                    .map(|&p| {
                        let d = &*p;
                        let name = if d.name.is_null() {
                            "Analog keyboard".into()
                        } else {
                            CStr::from_ptr(d.name).to_string_lossy().into_owned()
                        };
                        Ok(AnalogDevice {
                            id: d.id.to_string(),
                            name,
                        })
                    })
                    .collect()
            }
        }
        pub fn read(&mut self, id: u64) -> Result<[f32; 256]> {
            // SAFETY: parallel output arrays share the same capacity, and selected ID came from enumeration.
            let count =
                unsafe { (self.read)(self.codes.as_mut_ptr(), self.values.as_mut_ptr(), 256, id) };
            if count < 0 {
                return Err(format!(
                    "Analog device read failed ({count}); output released."
                ));
            }
            if count > 256 {
                return Err("SDK returned an invalid sample count.".into());
            }
            let mut values = [0.0; 256];
            for i in 0..count as usize {
                let code = self.codes[i] as usize;
                if code < 256 {
                    let v = self.values[i];
                    if !v.is_finite() || !(0.0..=1.0).contains(&v) {
                        return Err("SDK returned invalid analog depth.".into());
                    }
                    values[code] = v;
                }
            }
            Ok(values)
        }
        pub fn stop(&mut self) {
            if self.active {
                unsafe {
                    (self.uninit)();
                }
                self.active = false;
            }
        }
    }
    impl Drop for Sdk {
        fn drop(&mut self) {
            self.stop();
            let _ = &self.library;
            let _ = self.version;
        }
    }
}
#[cfg(feature = "wooting")]
pub use sdk::Sdk;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn threshold_and_shift_release_are_latched() {
        let p = crate::config::Profile::default();
        let mut a = AnalogProcessor::default();
        let now = Instant::now();
        let mut depths = [0.0; 256];
        depths[30] = 0.1;
        a.process(&depths, &p.analog, false, now);
        depths[30] = 0.7;
        let notes = a.process(
            &depths,
            &p.analog,
            false,
            now + std::time::Duration::from_millis(10),
        );
        assert_eq!(notes[0].data1, 36);
        assert!(notes[0].data2 >= 1);
        depths[225] = 1.0;
        assert!(a.process(&depths, &p.analog, false, now).is_empty());
        depths[30] = 0.0;
        assert_eq!(
            a.process(&depths, &p.analog, false, now),
            vec![MidiEvent::note_off(0, 36)]
        );
        depths[30] = 1.0;
        assert_eq!(a.process(&depths, &p.analog, false, now)[0].data1, 37);
    }
}
