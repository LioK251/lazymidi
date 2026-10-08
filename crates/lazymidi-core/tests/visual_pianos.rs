use lazymidi_core::{
    config,
    engine::{Engine, OutputAction},
    midi::MidiEvent,
    qwerty,
    routing::{Destination, Route, Source},
};

#[test]
fn velocity_toggle_preserves_notes_and_modifiers_for_both_inputs() {
    for source in [Source::Midi, Source::Analog] {
        for enabled in [true, false] {
            let mut p = config::visual_profile();
            p.game_velocity = enabled;
            let mut engine = Engine::default();
            let actions = engine.process(source, MidiEvent::note_on(0, 37, 100), &p, true, false);
            let [OutputAction::Chord {
                hid,
                modifiers,
                velocity,
            }] = actions.as_slice()
            else {
                panic!("expected one note chord");
            };
            assert_eq!(modifiers, &[225]);
            assert_eq!(*velocity, enabled.then_some(100));
            assert_eq!(
                qwerty::chord(*hid, modifiers, *velocity).contains(&OutputAction::Key {
                    hid: 226,
                    down: true
                }),
                enabled
            );
            assert_eq!(
                engine.process(source, MidiEvent::note_off(0, 37), &p, true, false),
                vec![OutputAction::Key {
                    hid: *hid,
                    down: false
                }]
            );
            assert!(engine.flush().is_empty());
        }
    }
}

#[test]
fn extended_toggle_filters_only_keyboard_output_and_preserves_releases() {
    for source in [Source::Midi, Source::Analog] {
        let mut p = config::visual_profile();
        p.routes.push(Route {
            id: "midi-output".into(),
            source,
            destination: Destination::Midi("synth".into()),
            enabled: true,
            channel: None,
            remap_channel: None,
        });
        let bindings = p.qwerty.clone();
        for enabled in [false, true] {
            p.extended_keys = enabled;
            let mut engine = Engine::default();
            for note in 21..=108 {
                let event = MidiEvent::note_on(0, note, 100);
                let actions = engine.process(source, event, &p, true, false);
                assert!(actions.contains(&OutputAction::Midi {
                    id: "synth".into(),
                    event
                }));
                assert_eq!(
                    actions
                        .iter()
                        .any(|a| matches!(a, OutputAction::Chord { .. })),
                    enabled || (36..=96).contains(&note)
                );
                let releases =
                    engine.process(source, MidiEvent::note_off(0, note), &p, true, false);
                assert_eq!(releases.len(), actions.len());
                assert!(engine.flush().is_empty());
            }
        }
        assert_eq!(p.qwerty, bindings);
        let mut engine = Engine::default();
        engine.process(source, MidiEvent::note_on(0, 21, 100), &p, true, false);
        p.extended_keys = false;
        assert_eq!(
            engine
                .process(source, MidiEvent::note_off(0, 21), &p, true, false)
                .len(),
            2
        );
        assert!(engine.flush().is_empty());
    }
}

#[test]
fn sustain_toggle_keeps_custom_binding_and_sostenuto_independent() {
    for source in [Source::Midi, Source::Analog] {
        let mut p = config::visual_profile();
        p.sustain_hid = Some(43);
        p.routes.push(Route {
            id: "midi-output".into(),
            source,
            destination: Destination::Midi("synth".into()),
            enabled: true,
            channel: None,
            remap_channel: None,
        });
        let mut engine = Engine::default();
        assert!(engine
            .process(source, MidiEvent::cc(0, 64, 127), &p, true, false)
            .contains(&OutputAction::Key {
                hid: 43,
                down: true
            }));
        p.sustain_enabled = false;
        let releases = engine.flush();
        assert!(releases.contains(&OutputAction::Key {
            hid: 43,
            down: false
        }));
        let event = MidiEvent::cc(0, 64, 127);
        assert_eq!(
            engine.process(source, event, &p, true, false),
            vec![OutputAction::Midi {
                id: "synth".into(),
                event
            }]
        );
        assert!(engine
            .process(source, MidiEvent::cc(0, 66, 127), &p, true, false)
            .contains(&OutputAction::Key {
                hid: 48,
                down: true
            }));
        p.sustain_enabled = true;
        assert_eq!(p.sustain_hid, Some(43));
        engine.process(source, MidiEvent::cc(0, 64, 127), &p, true, false);
        p.sustain_enabled = false;
        assert!(engine
            .process(source, MidiEvent::cc(0, 64, 0), &p, true, false)
            .contains(&OutputAction::Key {
                hid: 43,
                down: false
            }));
        engine.process(source, MidiEvent::cc(0, 66, 0), &p, true, false);
        assert!(engine.flush().is_empty());
    }
}

#[test]
fn all_eighty_eight_notes_match_the_upstream_game_protocol() {
    let p = config::visual_profile();
    p.validate().unwrap();
    assert_eq!(p.qwerty.len(), 88);
    let regular = b"1!2@34$5%6^78*9(0qQwWeErtTyYuiIoOpPasSdDfgGhHjJklLzZxcCvVbBnm";
    let low = b"trewq0987654321";
    let high = b"yuiopasdfghj";
    for note in 21..=108 {
        let b = &p.qwerty[(note - 21) as usize];
        assert_eq!(b.note, note);
        let char = if note < 36 {
            low[(35 - note) as usize]
        } else if note > 96 {
            high[(note - 97) as usize]
        } else {
            regular[(note - 36) as usize]
        };
        let base = match char {
            b'!' => b'1',
            b'@' => b'2',
            b'$' => b'4',
            b'%' => b'5',
            b'^' => b'6',
            b'*' => b'8',
            b'(' => b'9',
            other => other.to_ascii_lowercase(),
        };
        let hid = if base.is_ascii_alphabetic() {
            (base - b'a') as u16 + 4
        } else if base == b'0' {
            39
        } else {
            (base - b'1') as u16 + 30
        };
        assert_eq!(b.hid, hid);
        assert_eq!(b.modifiers.contains(&224), !(36..=96).contains(&note));
        assert_eq!(
            b.modifiers.contains(&225),
            char.is_ascii_uppercase() || b"!@$%^*(".contains(&char)
        );
    }
    assert_eq!(p.analog, config::Profile::default().analog);
}

#[test]
fn velocity_pulses_and_modifiers_finish_before_the_next_note() {
    assert_eq!(qwerty::velocity_hid(4), 30);
    assert_eq!(qwerty::velocity_hid(127), 6);
    assert_eq!(qwerty::velocity_hid(6), 30);
    let actions = qwerty::chord(30, &[224, 225], Some(100));
    let mut held = std::collections::HashSet::new();
    for action in &actions {
        if let OutputAction::Key { hid, down } = action {
            if *down {
                held.insert(*hid);
            } else {
                held.remove(hid);
            }
        }
    }
    assert_eq!(held, std::collections::HashSet::from([30]));
    assert!(actions.contains(&OutputAction::Key {
        hid: 226,
        down: true
    }));
    let p = config::visual_profile();
    let mut e = Engine::default();
    assert!(
        matches!(&e.process(Source::Midi,MidiEvent::note_on(0,37,100),&p,true,false)[0],OutputAction::Chord{modifiers,..} if modifiers==&[225])
    );
    assert!(
        matches!(&e.process(Source::Midi,MidiEvent::note_on(0,21,100),&p,true,false)[0],OutputAction::Chord{modifiers,..} if modifiers==&[224])
    );
    assert!(e
        .flush_source(Source::Midi)
        .iter()
        .all(|a| matches!(a, OutputAction::Key { down: false, .. })));
}

#[test]
fn shared_physical_keys_and_pedals_release_after_the_final_owner() {
    let p = config::visual_profile();
    let mut e = Engine::default();
    for source in [Source::Midi, Source::Analog] {
        e.process(source, MidiEvent::note_on(0, 36, 100), &p, true, false);
        e.process(source, MidiEvent::cc(0, 64, 127), &p, true, false);
    }
    assert!(e.flush_source(Source::Midi).is_empty());
    let releases = e.flush();
    assert!(releases.contains(&OutputAction::Key {
        hid: 30,
        down: false
    }));
    assert!(releases.contains(&OutputAction::Key {
        hid: 44,
        down: false
    }));
    let mut bad = p;
    bad.qwerty[0].modifiers = vec![224, 224];
    assert!(bad.validate().is_err());
}

#[test]
fn analog_press_flows_to_game_keys_with_measured_velocity() {
    use lazymidi_core::analog::AnalogProcessor;
    use std::time::{Duration, Instant};
    let profile = config::visual_profile();
    let mut analog = AnalogProcessor::default();
    let mut engine = Engine::default();
    let start = Instant::now();
    let mut depth = [0.0; 256];
    depth[23] = 0.1; // T -> C4 in the unchanged analog preset.
    depth[225] = 0.2; // Left Shift raises the note by one semitone.
    assert!(analog
        .process(&depth, &profile.analog, false, start)
        .is_empty());
    depth[23] = 0.8;
    let events = analog.process(
        &depth,
        &profile.analog,
        false,
        start + Duration::from_millis(10),
    );
    let note = events.iter().find(|e| e.kind() == 0x90).copied().unwrap();
    assert_eq!(note.data1, 61);
    assert!((1..127).contains(&note.data2));
    let actions = engine.process(Source::Analog, note, &profile, true, false);
    let OutputAction::Chord {
        hid,
        modifiers,
        velocity,
    } = &actions[0]
    else {
        panic!("expected game output");
    };
    assert_eq!(*velocity, Some(note.data2));
    assert!(modifiers.contains(&225));
    assert!(
        qwerty::chord(*hid, modifiers, *velocity).contains(&OutputAction::Key {
            hid: 226,
            down: true
        })
    );
    depth.fill(0.0);
    for release in analog.process(
        &depth,
        &profile.analog,
        false,
        start + Duration::from_millis(20),
    ) {
        assert!(!engine
            .process(Source::Analog, release, &profile, true, false)
            .is_empty());
    }
    assert!(engine.active_notes().is_empty());
}
