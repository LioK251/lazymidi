use crate::{config::Profile, platform::key_supported, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub sequence: Vec<i8>,
    pub up: Option<u16>,
    pub down: Option<u16>,
    pub next_shortcut: Option<String>,
    pub previous_shortcut: Option<String>,
    pub pause_shortcut: Option<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            sequence: vec![0],
            up: None,
            down: None,
            next_shortcut: None,
            previous_shortcut: None,
            pause_shortcut: None,
        }
    }
}
impl Config {
    pub fn validate(&self, profile: &Profile) -> Result<()> {
        if self.sequence.is_empty()
            || self.sequence.len() > 512
            || self.sequence.iter().any(|v| !(-50..=50).contains(v))
        {
            return Err("Transpose sequence needs 1–512 values between −50 and 50.".into());
        }
        if self.up.is_some() && self.up == self.down {
            return Err("Transpose Up and Down must differ.".into());
        }
        for hid in self.up.into_iter().chain(self.down) {
            if !key_supported(hid)
                || (224..=231).contains(&hid)
                || profile
                    .qwerty
                    .iter()
                    .any(|b| b.hid == hid || b.modifiers.contains(&hid))
                || profile.sustain_hid == Some(hid)
                || profile.sostenuto_hid == Some(hid)
                || (profile.visual_pianos
                    && (1..=127).any(|v| crate::qwerty::velocity_hid(v) == hid))
            {
                return Err("Transpose controls must use supported keys separate from notes, pedals and velocity commands.".into());
            }
        }
        let mut seen = std::collections::HashSet::new();
        for shortcut in [
            &self.next_shortcut,
            &self.previous_shortcut,
            &self.pause_shortcut,
        ]
        .into_iter()
        .flatten()
        {
            if shortcut.is_empty() || shortcut.len() > 100 || !seen.insert(shortcut.to_lowercase())
            {
                return Err(
                    "Transpose shortcuts must be distinct and at most 100 characters.".into(),
                );
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub current: Option<i8>,
    pub selected: usize,
    pub armed: bool,
    pub busy: bool,
    pub target: Option<i8>,
    pub completed: u8,
    pub total: u8,
    pub editing: bool,
    pub error: Option<String>,
    #[serde(skip)]
    pub job: u64,
    #[serde(skip)]
    pub start: i8,
    #[serde(skip)]
    pub direction: i8,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            current: Some(0),
            selected: 0,
            armed: false,
            busy: false,
            target: None,
            completed: 0,
            total: 0,
            editing: false,
            error: None,
            job: 0,
            start: 0,
            direction: 0,
        }
    }
}
impl Status {
    pub fn sync(&mut self, value: i8) -> Result<()> {
        if self.busy || !(-50..=50).contains(&value) {
            return Err("Stop transposing and enter the game’s current value (−50…50).".into());
        }
        self.current = Some(value);
        self.armed = false;
        self.error = None;
        Ok(())
    }
    pub fn arm(&mut self, enabled: bool, config: &Config) -> Result<()> {
        if enabled && (config.up.is_none() || config.down.is_none()) {
            return Err("Assign the game’s Up/Down keys in Transposer.".into());
        }
        if enabled {
            // shortcut: assume zero without game telemetry; replace if a game-value API becomes available.
            self.current.get_or_insert(0);
        }
        self.armed = enabled;
        self.error = None;
        Ok(())
    }
    pub fn resume(&mut self, config: &Config) -> Result<Option<(u64, u16, u8)>> {
        if self.editing {
            return Err("Finish editing before resuming Transposer.".into());
        }
        self.arm(true, config)?;
        self.step(0, config)
    }
    pub fn select(&mut self, index: usize, config: &Config) -> Result<()> {
        if index >= config.sequence.len() {
            return Err("Invalid sequence position.".into());
        }
        self.selected = index;
        Ok(())
    }
    pub fn step(&mut self, delta: i8, config: &Config) -> Result<Option<(u64, u16, u8)>> {
        if !self.armed || self.editing || self.busy {
            return Ok(None);
        }
        let next = (self.selected as isize + delta as isize)
            .rem_euclid(config.sequence.len() as isize) as usize;
        self.selected = next;
        let target = config.sequence[next];
        let current = self.current.ok_or("Confirm the current game value.")?;
        let difference = target - current;
        if difference == 0 {
            return Ok(None);
        }
        self.job += 1;
        self.start = current;
        self.direction = difference.signum();
        self.completed = 0;
        self.total = difference.unsigned_abs();
        self.target = Some(target);
        self.busy = true;
        self.error = None;
        Ok(Some((
            self.job,
            if difference > 0 {
                config.up
            } else {
                config.down
            }
            .ok_or("Assign transpose controls.")?,
            self.total,
        )))
    }
    pub fn progress(&mut self, job: u64, completed: u8, finished: bool, error: Option<String>) {
        if job != self.job {
            return;
        }
        self.completed = completed.min(self.total);
        self.current = Some(self.start + self.direction * self.completed as i8);
        if finished {
            self.busy = false;
            self.target = None;
        }
        if let Some(error) = error {
            self.error = Some(format!(
                "{error} Reset the game transpose to 0 before resuming."
            ));
            self.armed = false;
            // A game may act on key-down before a cancelled pulse's key-up.
            self.current = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_aligns_selected_entry_and_clears_errors() {
        let c = Config {
            sequence: vec![4, -3, -3],
            up: Some(82),
            down: Some(81),
            ..Config::default()
        };
        let mut s = Status::default();
        assert!(s
            .resume(&Config::default())
            .unwrap_err()
            .contains("Up/Down"));
        assert_eq!(s.current, Some(0));
        assert!(!s.armed);
        s.error = Some("old failure".into());
        assert_eq!(s.resume(&c).unwrap(), Some((1, 82, 4)));
        assert_eq!(s.current, Some(0));
        assert_eq!(s.target, Some(4));
        assert!(s.error.is_none());
        s.progress(1, 4, true, None);
        assert_eq!(s.step(1, &c).unwrap(), Some((2, 81, 7)));
        s.progress(2, 7, true, None);
        assert_eq!(s.step(1, &c).unwrap(), None);
        assert_eq!(s.step(1, &c).unwrap(), Some((3, 82, 7)));
        s.progress(3, 7, true, None);
        s.armed = false;
        s.select(1, &c).unwrap();
        assert_eq!(s.resume(&c).unwrap(), Some((4, 81, 7)));
        s.progress(4, 7, true, None);
        s.editing = true;
        assert!(s.resume(&c).is_err());
    }
    #[test]
    fn wrapping_delta_and_partial_completion() {
        let c = Config {
            sequence: vec![-2, 3, 3],
            up: Some(82),
            down: Some(81),
            ..Config::default()
        };
        let mut s = Status::default();
        s.sync(-2).unwrap();
        s.arm(true, &c).unwrap();
        assert_eq!(s.step(1, &c).unwrap(), Some((1, 82, 5)));
        s.progress(1, 2, true, Some("cancelled".into()));
        assert_eq!(s.current, None);
        assert!(!s.armed);
        assert!(s
            .error
            .as_ref()
            .unwrap()
            .contains("Reset the game transpose to 0"));
        s.arm(true, &c).unwrap();
        assert_eq!(s.current, Some(0));
        assert!(s.error.is_none());
        s.step(1, &c).unwrap();
        s.progress(2, 3, true, None);
        assert_eq!(s.current, Some(3));
        assert_eq!(s.step(-1, &c).unwrap(), None);
        assert_eq!(s.step(-1, &c).unwrap(), Some((3, 81, 5)));
        assert!(s.sync(4).is_err());
    }
}
