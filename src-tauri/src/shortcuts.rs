use crate::commands::App;
use lazymidi_core::runtime::{Command, Snapshot};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn validate(profile: &lazymidi_core::config::Profile) -> Result<(), String> {
    let config = &profile.transpose;
    let mut shortcuts = HashSet::new();
    for text in [
        &config.next_shortcut,
        &config.previous_shortcut,
        &config.pause_shortcut,
    ]
    .into_iter()
    .flatten()
    {
        let shortcut: Shortcut = text
            .parse()
            .map_err(|e| format!("Invalid shortcut {text}: {e}"))?;
        if !shortcuts.insert(shortcut.id()) {
            return Err("Transpose shortcuts must differ.".into());
        }
        let mut outputs: Vec<u16> = config
            .up
            .into_iter()
            .chain(config.down)
            .chain(profile.sustain_hid)
            .chain(profile.sostenuto_hid)
            .collect();
        outputs.extend(
            profile
                .qwerty
                .iter()
                .flat_map(|b| std::iter::once(b.hid).chain(b.modifiers.iter().copied())),
        );
        if profile.visual_pianos {
            outputs.extend((1..=127).map(lazymidi_core::qwerty::velocity_hid));
        }
        if outputs
            .into_iter()
            .filter_map(hid_code)
            .any(|code| format!("{:?}", shortcut.key) == code)
        {
            return Err(
                "Global shortcuts cannot use generated note, pedal, velocity or transpose keys."
                    .into(),
            );
        }
    }
    Ok(())
}
pub fn install(app: &tauri::AppHandle, state: &Snapshot) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    if !state.settings.show_transposer || state.transpose.editing {
        return Ok(());
    }
    let config = &state.settings.profile().transpose;
    validate(state.settings.profile())?;
    for (binding, action) in [
        (&config.next_shortcut, "next"),
        (&config.previous_shortcut, "previous"),
        (&config.pause_shortcut, "toggle"),
    ] {
        if let Some(text) = binding {
            let held = Arc::new(AtomicBool::new(false));
            let shortcut: Shortcut = text.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
            if let Err(error) = app
                .global_shortcut()
                .on_shortcut(shortcut, move |app, _, event| {
                    if event.state() == ShortcutState::Released {
                        held.store(false, Ordering::Release);
                        return;
                    }
                    if held.swap(true, Ordering::AcqRel) {
                        return;
                    }
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let state = handle.state::<App>();
                        if !state.runtime.snapshot().transpose.editing {
                            let _ = state.runtime.command(Command::Transpose {
                                action: action.into(),
                                value: None,
                                index: None,
                            });
                        }
                    });
                })
            {
                let _ = app.global_shortcut().unregister_all();
                return Err(format!("Shortcut unavailable ({text}): {error}"));
            }
        }
    }
    Ok(())
}

fn hid_code(hid: u16) -> Option<String> {
    Some(match hid {
        4..=29 => format!("Key{}", char::from_u32((hid - 4 + 65) as u32)?),
        30..=38 => format!("Digit{}", hid - 29),
        39 => "Digit0".into(),
        58..=69 => format!("F{}", hid - 57),
        89..=97 => format!("Numpad{}", hid - 88),
        98 => "Numpad0".into(),
        _ => match hid {
            40 => "Enter",
            41 => "Escape",
            42 => "Backspace",
            43 => "Tab",
            44 => "Space",
            45 => "Minus",
            46 => "Equal",
            47 => "BracketLeft",
            48 => "BracketRight",
            49 => "Backslash",
            51 => "Semicolon",
            52 => "Quote",
            53 => "Backquote",
            54 => "Comma",
            55 => "Period",
            56 => "Slash",
            57 => "CapsLock",
            73 => "Insert",
            74 => "Home",
            75 => "PageUp",
            76 => "Delete",
            77 => "End",
            78 => "PageDown",
            79 => "ArrowRight",
            80 => "ArrowLeft",
            81 => "ArrowDown",
            82 => "ArrowUp",
            84 => "NumpadDivide",
            85 => "NumpadMultiply",
            86 => "NumpadSubtract",
            87 => "NumpadAdd",
            88 => "NumpadEnter",
            99 => "NumpadDecimal",
            224 => "ControlLeft",
            225 => "ShiftLeft",
            226 => "AltLeft",
            227 => "MetaLeft",
            228 => "ControlRight",
            229 => "ShiftRight",
            230 => "AltRight",
            231 => "MetaRight",
            _ => return None,
        }
        .into(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcuts_cannot_retrigger_generated_output() {
        let mut p = lazymidi_core::config::Settings::default().profile().clone();
        p.transpose.next_shortcut = Some("Ctrl+Shift+F9".into());
        assert!(validate(&p).is_ok());
        p.transpose.next_shortcut = Some("Ctrl+KeyA".into());
        assert!(validate(&p).is_err());
        p.transpose.next_shortcut = Some("F9".into());
        p.transpose.previous_shortcut = Some("F9".into());
        assert!(validate(&p).is_err());
        p.transpose.previous_shortcut = None;
        p.transpose.up = Some(66);
        assert!(validate(&p).is_err());
        p.transpose.up = Some(45);
        p.transpose.next_shortcut = Some("Minus".into());
        assert!(validate(&p).is_err());
    }
}
