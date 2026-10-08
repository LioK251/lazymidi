use lazymidi_core::{
    analog::AnalogProcessor,
    config::{self, Profile, Settings},
    engine::{Engine, OutputAction},
    midi::MidiEvent,
    routing::{self, Destination, Route, Source},
    runtime::{Command, Runtime},
    sequencer::{Sequencer, StepNote},
};
use std::time::{Duration, Instant};

fn route(source: Source, destination: Destination, id: &str) -> Route {
    Route {
        id: id.into(),
        source,
        destination,
        enabled: true,
        channel: None,
        remap_channel: None,
    }
}

#[test]
fn exact_preset_survives_import_and_export() {
    let supplied = serde_json::json!({"keymapping":{"0":[[30,36],[31,38],[32,40],[33,41],[34,43],[35,45],[36,47],[37,48],[38,50],[39,52],[20,53],[26,55],[8,57],[21,59],[23,60],[28,62],[24,64],[12,65],[18,67],[19,69],[4,71],[22,72],[7,74],[9,76],[10,77],[11,79],[13,81],[14,83],[15,84],[29,86],[27,88],[6,89],[25,91],[5,93],[17,95],[16,96]]},"shift_amount":1,"note_config":{"threshold":0.5,"velocity_scale":1}});
    let actual: serde_json::Value = serde_json::from_str(config::DEFAULT_ANALOG).unwrap();
    assert_eq!(actual, supplied);
    let p = config::import_profile(config::DEFAULT_ANALOG).unwrap();
    assert_eq!(p.analog, Profile::default().analog);
    let exported = serde_json::json!({"version":1,"profile":p});
    assert_eq!(
        config::import_profile(&exported.to_string())
            .unwrap()
            .qwerty
            .len(),
        36
    );
}

#[test]
fn analog_multiple_bindings_aftertouch_and_reset() {
    let mut p = Profile::default();
    p.analog.keymapping.insert(1, vec![(30, 48), (30, 52)]);
    let mut a = AnalogProcessor::default();
    let mut values = [0.0; 256];
    let now = Instant::now();
    values[30] = 0.7;
    let notes = a.process(&values, &p.analog, true, now);
    assert_eq!(notes.len(), 3);
    values[30] = 0.9;
    assert_eq!(a.process(&values, &p.analog, true, now).len(), 3);
    assert_eq!(a.reset().len(), 3);
    assert!(a.process(&values, &p.analog, true, now).is_empty());
    values[30] = 0.0;
    a.process(&values, &p.analog, true, now);
    values[30] = 1.0;
    assert_eq!(a.process(&values, &p.analog, true, now).len(), 3);
    values[30] = f32::NAN;
    assert!(a.process(&values, &p.analog, true, now).is_empty());
}

#[test]
fn source_to_recorder_to_playback_releases_all_destinations() {
    for input in [Source::Midi, Source::Analog] {
        let p = Profile {
            routes: vec![
                route(input, Destination::Recorder(0), "record"),
                route(
                    Source::Sequencer(0),
                    Destination::Midi("synth".into()),
                    "play-midi",
                ),
                route(Source::Sequencer(0), Destination::Qwerty, "play-key"),
            ],
            ..Profile::default()
        };
        p.validate().unwrap();
        let mut engine = Engine::default();
        let mut sequence = Sequencer::default();
        sequence.recording = true;
        let now = Instant::now();
        for action in engine.process(input, MidiEvent::note_on(0, 36, 100), &p, false, false) {
            if let OutputAction::Record { track: 0, event } = action {
                sequence.record(event, now);
            }
        }
        sequence.tick(now + Duration::from_millis(31));
        assert_eq!(sequence.project.tracks[0].steps[0].notes.len(), 1);
        sequence.play(now);
        let output: Vec<_> = sequence
            .tick(now)
            .into_iter()
            .flat_map(|(s, e)| engine.process(s, e, &p, true, false))
            .collect();
        assert_eq!(output.len(), 2);
        let releases: Vec<_> = sequence
            .stop()
            .into_iter()
            .flat_map(|(s, e)| engine.process(s, e, &p, true, false))
            .collect();
        assert_eq!(releases.len(), 2);
        assert!(engine.flush().is_empty());
    }
}

#[test]
fn route_cycles_duplicates_and_unmapped_notes_are_rejected() {
    assert!(routing::validate(&[route(
        Source::Sequencer(0),
        Destination::Recorder(1),
        "cycle"
    )])
    .is_err());
    assert!(routing::validate(&[
        route(Source::Midi, Destination::Qwerty, "a"),
        route(Source::Midi, Destination::Qwerty, "b")
    ])
    .is_err());
    let mut engine = Engine::default();
    let p = Profile::default();
    assert!(engine
        .process(Source::Midi, MidiEvent::note_on(0, 0, 100), &p, true, false)
        .is_empty());
    assert!(engine
        .process(
            Source::Midi,
            MidiEvent::note_on(0, 36, 100),
            &p,
            false,
            false
        )
        .is_empty());
    engine.process(
        Source::Midi,
        MidiEvent::note_on(0, 36, 100),
        &p,
        true,
        false,
    );
    assert_eq!(
        engine
            .process(Source::Midi, MidiEvent::cc(0, 123, 0), &p, true, false)
            .len(),
        1
    );
    assert!(engine.active_notes().is_empty());
}

#[test]
fn absolute_deadlines_have_no_cumulative_drift_over_thirty_minutes() {
    let mut s = Sequencer::default();
    for step in &mut s.project.tracks[0].steps {
        step.notes = vec![StepNote {
            note: 36,
            velocity: 100,
        }];
    }
    let mut engine = Engine::default();
    let p = Profile {
        routes: vec![route(Source::Sequencer(0), Destination::Qwerty, "play")],
        ..Profile::default()
    };
    let origin = Instant::now();
    s.play(origin);
    let mut note_count = 0;
    for n in 0..14400 {
        let deadline = origin + Duration::from_millis(n * 125);
        let events = s.tick(deadline);
        note_count += events.iter().filter(|(_, e)| e.kind() == 0x90).count();
        for (source, event) in events {
            engine.process(source, event, &p, true, false);
        }
        for (source, event) in s.tick(deadline + Duration::from_millis(101)) {
            engine.process(source, event, &p, true, false);
        }
        assert!(engine.active_notes().is_empty());
        assert_eq!(
            s.next_deadline(),
            Some(deadline + Duration::from_millis(125))
        );
    }
    assert_eq!(note_count, 14400);
    assert!(s.stop().is_empty());
}

#[test]
fn startup_without_sdk_and_stale_edits_are_recoverable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    let settings = Settings {
        sdk_path: Some(directory.path().join("missing.dll")),
        ..Settings::default()
    };
    config::atomic_save(&path, &settings).unwrap();
    let runtime = Runtime::start_at(path).unwrap();
    let initial = runtime.snapshot();
    assert!(!initial.analog_enabled);
    assert!(!initial.qwerty_enabled);
    runtime.command(Command::Qwerty { enabled: false }).unwrap();
    assert!(runtime
        .command(Command::Settings {
            settings: initial.settings.clone(),
            expected_revision: 99
        })
        .is_err());
    let revision = runtime.snapshot().revision;
    let updated = runtime
        .command(Command::Settings {
            settings: initial.settings,
            expected_revision: revision,
        })
        .unwrap();
    assert_eq!(updated.revision, revision + 1);
    runtime.command(Command::Panic).unwrap();
    assert!(!runtime.snapshot().qwerty_enabled);
    runtime.stop();
    assert!(runtime.is_stopped());
}

#[test]
fn settings_command_accepts_json_channel_keys_from_desktop_ipc() {
    let mut settings = Settings::default();
    settings.profiles[1].analog.shift_amount = 2;
    settings.profiles[1].analog.note_config.threshold = 0.25;
    settings.profiles[1].analog.note_config.velocity_scale = 0.62;
    let payload = serde_json::to_value(Command::Settings {
        settings,
        expected_revision: 7,
    })
    .unwrap();
    let Command::Settings {
        settings,
        expected_revision,
    } = serde_json::from_value(payload.clone()).unwrap()
    else {
        panic!("expected settings command");
    };
    settings.validate().unwrap();
    assert_eq!(expected_revision, 7);
    assert_eq!(settings.profile().analog.shift_amount, 2);
    assert_eq!(settings.profile().analog.note_config.threshold, 0.25);
    assert_eq!(settings.profile().analog.note_config.velocity_scale, 0.62);
    assert_eq!(settings.profile().analog.keymapping[&0].len(), 36);
    for key in ["invalid", "00", "16"] {
        let mut invalid = payload.clone();
        invalid["settings"]["profiles"][1]["analog"]["keymapping"] =
            serde_json::json!({key: [[23,60]]});
        assert!(serde_json::from_value::<Command>(invalid).is_err());
    }
}

#[test]
fn invalid_settings_and_failed_save_preserve_recovery_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    config::atomic_save(&path, &Settings::default()).unwrap();
    std::fs::write(&path, "invalid original").unwrap();
    config::atomic_save(&path, &Settings::default()).unwrap();
    let copies: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains("invalid-"))
        .collect();
    assert_eq!(copies.len(), 1);
    assert_eq!(
        std::fs::read_to_string(copies[0].path()).unwrap(),
        "invalid original"
    );
    let blocked = dir.path().join("directory.json");
    std::fs::create_dir(&blocked).unwrap();
    assert!(config::atomic_save(&blocked, &Settings::default()).is_err());
    assert!(blocked.is_dir());
}

#[cfg(feature = "wooting")]
#[test]
fn incompatible_sdk_is_a_recoverable_loader_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(if cfg!(windows) {
        "incompatible.dll"
    } else {
        "incompatible.so"
    });
    std::fs::write(&path, b"invalid library bytes").unwrap();
    assert!(lazymidi_core::analog::Sdk::load(&path).is_err());
}
