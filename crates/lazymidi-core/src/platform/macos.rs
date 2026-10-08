use crate::Result;
use core_graphics::{
    event::{CGEvent, CGEventFlags, CGEventTapLocation},
    event_source::{CGEventSource, CGEventSourceStateID},
};
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: *const std::ffi::c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: *const std::ffi::c_void;
    fn CFDictionaryCreate(
        allocator: *const std::ffi::c_void,
        keys: *const *const std::ffi::c_void,
        values: *const *const std::ffi::c_void,
        count: isize,
        key_callbacks: *const std::ffi::c_void,
        value_callbacks: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
    fn CFRelease(object: *const std::ffi::c_void);
}
pub struct Keyboard {
    modifiers: std::collections::HashSet<u16>,
}
impl Keyboard {
    pub fn new() -> Result<Self> {
        // SAFETY: no-argument system permission query.
        let trusted = unsafe {
            if AXIsProcessTrusted() {
                true
            } else {
                // Borrowed system constants remain live through the permission call.
                let keys = [kAXTrustedCheckOptionPrompt];
                let values = [kCFBooleanTrue];
                let options = CFDictionaryCreate(
                    std::ptr::null(),
                    keys.as_ptr(),
                    values.as_ptr(),
                    1,
                    std::ptr::null(),
                    std::ptr::null(),
                );
                if options.is_null() {
                    false
                } else {
                    let trusted = AXIsProcessTrustedWithOptions(options);
                    CFRelease(options);
                    trusted
                }
            }
        };
        if !trusted {
            return Err("Allow lazymidi in System Settings → Privacy & Security → Accessibility, then enable output again.".into());
        }
        Ok(Self {
            modifiers: Default::default(),
        })
    }
    pub fn write(&mut self, hid: u16, down: bool) -> Result<()> {
        let (_, code) = super::key_codes(hid)?;
        if (224..=231).contains(&hid) {
            if down {
                self.modifiers.insert(hid);
            } else {
                self.modifiers.remove(&hid);
            }
        }
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Cannot create keyboard event source.")?;
        let event = CGEvent::new_keyboard_event(source, code, down)
            .map_err(|_| "Cannot create keyboard event.")?;
        let mut flags = CGEventFlags::empty();
        for &m in &self.modifiers {
            flags |= match m {
                225 | 229 => CGEventFlags::CGEventFlagShift,
                224 | 228 => CGEventFlags::CGEventFlagControl,
                226 | 230 => CGEventFlags::CGEventFlagAlternate,
                227 | 231 => CGEventFlags::CGEventFlagCommand,
                _ => CGEventFlags::empty(),
            };
        }
        event.set_flags(flags);
        event.post(CGEventTapLocation::HID);
        Ok(())
    }
}
