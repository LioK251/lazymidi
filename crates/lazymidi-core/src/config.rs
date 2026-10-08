use crate::{platform::key_supported, routing::Route, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const DEFAULT_ANALOG: &str = include_str!("../resources/presets/default-analog.json");
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NoteConfig {
    pub threshold: f32,
    pub velocity_scale: f32,
}
pub type AnalogKeyMapping = BTreeMap<u8, Vec<(u16, u8)>>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AnalogPreset {
    #[serde(deserialize_with = "deserialize_keymapping")]
    pub keymapping: AnalogKeyMapping,
    pub shift_amount: i16,
    pub note_config: NoteConfig,
}
fn deserialize_keymapping<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<AnalogKeyMapping, D::Error> {
    // Tagged IPC commands lose JSON's special numeric map-key deserializer.
    let mappings = BTreeMap::<String, Vec<(u16, u8)>>::deserialize(deserializer)?;
    mappings
        .into_iter()
        .map(|(key, pairs)| {
            let channel: u8 = key.parse().map_err(serde::de::Error::custom)?;
            if channel > 15 || channel.to_string() != key {
                return Err(serde::de::Error::custom("Mapping channels must be 0–15."));
            }
            Ok((channel, pairs))
        })
        .collect()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KeyBinding {
    pub channel: u8,
    pub note: u8,
    pub hid: u16,
    #[serde(default)]
    pub modifiers: Vec<u16>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    Analog,
    Midi,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub analog: AnalogPreset,
    pub qwerty: Vec<KeyBinding>,
    pub routes: Vec<Route>,
    #[serde(default)]
    pub visual_pianos: bool,
    #[serde(default)]
    pub game_velocity: bool,
    #[serde(default = "enabled_by_default")]
    pub sustain_enabled: bool,
    #[serde(default = "enabled_by_default")]
    pub extended_keys: bool,
    #[serde(default)]
    pub sustain_hid: Option<u16>,
    #[serde(default)]
    pub sostenuto_hid: Option<u16>,
}
fn enabled_by_default() -> bool {
    true
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    pub selected_profile: String,
    pub profiles: Vec<Profile>,
    pub input_mode: InputMode,
    pub preferred_midi: Option<String>,
    pub sdk_path: Option<PathBuf>,
    pub analog_device: Option<String>,
    pub polling_hz: u16,
    pub aftertouch: bool,
    #[serde(default)]
    pub both_inputs: bool,
}
impl Default for Profile {
    fn default() -> Self {
        let analog: AnalogPreset =
            serde_json::from_str(DEFAULT_ANALOG).expect("embedded preset is checked by tests");
        let qwerty = analog
            .keymapping
            .iter()
            .flat_map(|(&channel, pairs)| {
                pairs.iter().map(move |&(hid, note)| KeyBinding {
                    channel,
                    note,
                    hid,
                    modifiers: vec![],
                })
            })
            .collect();
        Self {
            id: "default-copy".into(),
            name: "Default copy".into(),
            analog,
            qwerty,
            routes: Route::defaults(),
            visual_pianos: false,
            game_velocity: false,
            sustain_enabled: false,
            extended_keys: true,
            sustain_hid: None,
            sostenuto_hid: None,
        }
    }
}
pub fn visual_profile() -> Profile {
    Profile {
        id: "visual-pianos".into(),
        name: "Visual Pianos · 88 keys".into(),
        qwerty: crate::qwerty::visual_bindings(),
        visual_pianos: true,
        game_velocity: true,
        sustain_enabled: true,
        sustain_hid: Some(44),
        sostenuto_hid: Some(48),
        ..Profile::default()
    }
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            selected_profile: "visual-pianos".into(),
            profiles: vec![Profile::default(), visual_profile()],
            input_mode: InputMode::Analog,
            preferred_midi: None,
            sdk_path: None,
            analog_device: None,
            polling_hz: 1000,
            aftertouch: true,
            both_inputs: false,
        }
    }
}
impl AnalogPreset {
    pub fn validate(&self) -> Result<()> {
        if !self.note_config.threshold.is_finite()
            || !(0.0..1.0).contains(&self.note_config.threshold)
        {
            return Err("Threshold must be between 0 (inclusive) and 1 (exclusive).".into());
        }
        if !self.note_config.velocity_scale.is_finite()
            || self.note_config.velocity_scale <= 0.0
            || self.note_config.velocity_scale > 10000.0
        {
            return Err("Velocity scale must be finite, positive and at most 10000.".into());
        }
        if !(-127..=127).contains(&self.shift_amount) || self.keymapping.len() > 16 {
            return Err("Invalid transposition or channel count.".into());
        }
        let mut seen = HashSet::new();
        for (&channel, pairs) in &self.keymapping {
            if channel > 15 || pairs.len() > 256 {
                return Err("Invalid channel or too many mappings.".into());
            }
            for &(hid, note) in pairs {
                if !key_supported(hid) || note > 127 || !seen.insert((channel, hid, note)) {
                    return Err(format!(
                        "Invalid or duplicate analog binding: channel {}, HID {}, note {}.",
                        channel + 1,
                        hid,
                        note
                    ));
                }
            }
        }
        Ok(())
    }
}
impl Profile {
    pub fn validate(&self) -> Result<()> {
        if self
            .sustain_hid
            .into_iter()
            .chain(self.sostenuto_hid)
            .any(|h| !key_supported(h))
        {
            return Err("Pedal output requires a supported physical key.".into());
        }
        if self.id.is_empty()
            || self.id.len() > 128
            || self.name.trim().is_empty()
            || self.name.len() > 128
        {
            return Err("Profile ID/name must contain 1–128 characters.".into());
        }
        self.analog.validate()?;
        if self.qwerty.len() > 2048 {
            return Err("Too many QWERTY bindings.".into());
        }
        let mut seen = HashSet::new();
        for binding in &self.qwerty {
            if binding.channel > 15
                || binding.note > 127
                || !key_supported(binding.hid)
                || !seen.insert((binding.channel, binding.note))
                || binding.modifiers.len() > 4
                || binding
                    .modifiers
                    .iter()
                    .any(|m| !(224..=231).contains(m) || *m == binding.hid)
                || binding.modifiers.iter().collect::<HashSet<_>>().len() != binding.modifiers.len()
            {
                return Err(
                    "QWERTY bindings require valid keys and unique channel/note pairs.".into(),
                );
            }
        }
        crate::routing::validate(&self.routes)
    }
}
impl Settings {
    pub fn profile(&self) -> &Profile {
        self.profiles
            .iter()
            .find(|p| p.id == self.selected_profile)
            .unwrap_or(&self.profiles[0])
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(format!(
                "Unsupported settings version {}. The file was not changed.",
                self.version
            ));
        }
        if self.profiles.is_empty()
            || self.profiles.len() > 128
            || ![100, 250, 500, 1000].contains(&self.polling_hz)
        {
            return Err("Invalid profile count or polling frequency.".into());
        }
        if self.sdk_path.as_ref().is_some_and(|p| !p.is_absolute()) {
            return Err("SDK library path must be absolute.".into());
        }
        let mut ids = HashSet::new();
        for profile in &self.profiles {
            profile.validate()?;
            if !ids.insert(&profile.id) {
                return Err("Profile IDs must be unique.".into());
            }
        }
        if !ids.contains(&self.selected_profile) {
            return Err("Selected profile does not exist.".into());
        }
        Ok(())
    }
}
pub fn data_dir() -> Result<PathBuf> {
    directories::ProjectDirs::from("app", "lazymidi", "lazymidi")
        .map(|p| p.config_dir().to_owned())
        .ok_or_else(|| "Application data directory is unavailable.".into())
}
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err("File exceeds the 1 MiB limit.".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    serde_json::from_reader(std::io::Read::take(file, MAX_FILE_BYTES + 1))
        .map_err(|e| e.to_string())
}
pub fn atomic_save<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().ok_or("File has no parent directory.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temp, value).map_err(|e| e.to_string())?;
    temp.write_all(b"\n").map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if path.exists() {
        // Keep a separate recovery copy before the normal one-backup rotation.
        if path.file_name().is_some_and(|n| n == "settings.json")
            && read_json::<Settings>(path)
                .and_then(|s| s.validate())
                .is_err()
        {
            let recovered = path.with_extension(format!(
                "invalid-{}.json",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos()
            ));
            fs::copy(path, recovered).map_err(|e| e.to_string())?;
        }
        let backup = path.with_extension("backup");
        let mut b = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        let mut old = fs::File::open(path).map_err(|e| e.to_string())?;
        std::io::copy(&mut old, &mut b).map_err(|e| e.to_string())?;
        b.as_file().sync_all().map_err(|e| e.to_string())?;
        b.persist(&backup).map_err(|e| e.to_string())?;
    }
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn load_settings(path: &Path) -> (Settings, Option<String>) {
    if !path.exists() {
        return (Settings::default(), None);
    }
    let read = read_json::<Settings>(path).and_then(|s| {
        s.validate()?;
        Ok(s)
    });
    match read {
        Ok(s) => (s, None),
        Err(error) => {
            // Preserve the original, including future-version files; no recovery writes at startup.
            let backup = read_json::<Settings>(&path.with_extension("backup")).and_then(|s| {
                s.validate()?;
                Ok(s)
            });
            (backup.unwrap_or_default(),Some(format!("Settings recovery: {error} Original file preserved; export it before saving new preferences.")))
        }
    }
}
pub fn import_profile(text: &str) -> Result<Profile> {
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err("Profile exceeds 1 MiB.".into());
    }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut profile = if value.get("keymapping").is_some() {
        let analog: AnalogPreset = serde_json::from_value(value).map_err(|e| e.to_string())?;
        Profile {
            analog,
            name: "Imported analog".into(),
            ..Profile::default()
        }
    } else {
        if value.get("version").and_then(|v| v.as_u64()) != Some(1) {
            return Err("Unsupported profile version.".into());
        }
        serde_json::from_value(value.get("profile").cloned().ok_or("Missing profile.")?)
            .map_err(|e| e.to_string())?
    };
    profile.validate()?;
    profile.id = format!(
        "profile-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn polling_preferences_preserve_old_rates_and_allow_low_latency_default() {
        let mut settings = Settings::default();
        assert_eq!(settings.polling_hz, 1000);
        let original = serde_json::to_value(&settings.profiles).unwrap();
        for hz in [100, 250, 500, 1000] {
            settings.polling_hz = hz;
            settings.validate().unwrap();
            let saved = serde_json::to_value(&settings).unwrap();
            let loaded: Settings = serde_json::from_value(saved).unwrap();
            assert_eq!(loaded.polling_hz, hz);
            assert_eq!(serde_json::to_value(loaded.profiles).unwrap(), original);
        }
        settings.polling_hz = 2000;
        assert!(settings.validate().is_err());
    }
    #[test]
    fn output_toggles_survive_files_and_legacy_imports() {
        let mut p = visual_profile();
        assert!(p.game_velocity && p.sustain_enabled && p.extended_keys);
        let mut legacy = serde_json::to_value(&p).unwrap();
        legacy.as_object_mut().unwrap().remove("sustain_enabled");
        legacy.as_object_mut().unwrap().remove("extended_keys");
        let imported =
            import_profile(&serde_json::json!({"version":1,"profile":legacy}).to_string()).unwrap();
        assert!(imported.sustain_enabled && imported.extended_keys);
        assert_eq!(imported.sustain_hid, Some(44));
        p.game_velocity = false;
        p.sustain_enabled = false;
        p.extended_keys = false;
        p.sustain_hid = Some(43);
        let imported =
            import_profile(&serde_json::json!({"version":1,"profile":p}).to_string()).unwrap();
        assert!(!imported.game_velocity && !imported.sustain_enabled && !imported.extended_keys);
        assert_eq!(imported.sustain_hid, Some(43));
        assert_eq!(imported.qwerty, p.qwerty);
        let settings = Settings {
            selected_profile: imported.id.clone(),
            profiles: vec![imported],
            ..Settings::default()
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        atomic_save(&path, &settings).unwrap();
        let (loaded, warning) = load_settings(&path);
        assert!(warning.is_none());
        assert!(
            !loaded.profile().game_velocity
                && !loaded.profile().sustain_enabled
                && !loaded.profile().extended_keys
        );
        assert_eq!(loaded.profile().sustain_hid, Some(43));
    }
    #[test]
    fn defaults_inverse_and_recovery() {
        let s = Settings::default();
        s.validate().unwrap();
        let p = &s.profiles[0];
        assert_eq!(p.qwerty.len(), 36);
        assert_eq!(p.analog.shift_amount, 1);
        assert_eq!(p.analog.note_config.velocity_scale, 1.0);
        assert_eq!(
            p.qwerty[0],
            KeyBinding {
                channel: 0,
                note: 36,
                hid: 30,
                modifiers: vec![]
            }
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        atomic_save(&path, &s).unwrap();
        atomic_save(&path, &s).unwrap();
        fs::write(&path, "broken").unwrap();
        let (recovered, warn) = load_settings(&path);
        recovered.validate().unwrap();
        assert!(warn.is_some());
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
        let mut bad = p.clone();
        bad.qwerty.push(bad.qwerty[0].clone());
        assert!(bad.validate().is_err());
        assert!(import_profile(r#"{"version":2}"#).is_err());
    }
}
