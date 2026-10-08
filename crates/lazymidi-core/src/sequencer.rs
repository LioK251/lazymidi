use crate::{midi::MidiEvent, routing::Source, Result};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StepNote {
    pub note: u8,
    pub velocity: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Step {
    pub notes: Vec<StepNote>,
    pub gate: f32,
}
impl Default for Step {
    fn default() -> Self {
        Self {
            notes: vec![],
            gate: 0.8,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Track {
    pub name: String,
    pub channel: u8,
    pub muted: bool,
    pub steps: Vec<Step>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub version: u32,
    pub name: String,
    pub bpm: f64,
    pub tracks: Vec<Track>,
}
impl Default for Project {
    fn default() -> Self {
        Self {
            version: 1,
            name: "Untitled".into(),
            bpm: 120.0,
            tracks: (0..4)
                .map(|i| Track {
                    name: format!("Track {}", i + 1),
                    channel: i,
                    muted: false,
                    steps: vec![Step::default(); 16],
                })
                .collect(),
        }
    }
}
impl Project {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.name.is_empty()
            || self.name.len() > 128
            || !self.bpm.is_finite()
            || !(20.0..=300.0).contains(&self.bpm)
            || self.tracks.len() != 4
        {
            return Err("Project requires version 1, a name, 20–300 BPM and four tracks.".into());
        }
        for t in &self.tracks {
            if t.channel > 15 || t.name.len() > 128 || t.steps.len() != 16 {
                return Err("Each track requires 16 steps and a valid MIDI channel.".into());
            }
            for s in &t.steps {
                if !s.gate.is_finite() || !(0.01..=1.0).contains(&s.gate) || s.notes.len() > 128 {
                    return Err("Step gate must be 1–100%, with at most 128 notes.".into());
                }
                let mut seen = std::collections::HashSet::new();
                for n in &s.notes {
                    if n.note > 127 || n.velocity == 0 || n.velocity > 127 || !seen.insert(n.note) {
                        return Err(
                            "Step notes require unique pitches and velocities 1–127.".into()
                        );
                    }
                }
            }
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Sequencer {
    pub project: Project,
    pub playing: bool,
    pub recording: bool,
    pub armed: u8,
    pub cursor: u8,
    pub step: u8,
    pub dirty: bool,
    next: Option<Instant>,
    pending: Vec<(Instant, Source, MidiEvent)>,
    group: Option<ChordGroup>,
}
struct ChordGroup {
    start: Instant,
    last: Instant,
    step: u8,
    notes: Vec<StepNote>,
}
impl Sequencer {
    pub fn play(&mut self, now: Instant) {
        if !self.playing {
            self.playing = true;
            self.step = 0;
            self.next = Some(now);
        }
    }
    pub fn stop(&mut self) -> Vec<(Source, MidiEvent)> {
        self.commit_group();
        self.playing = false;
        self.recording = false;
        self.next = None;
        self.step = 0;
        self.pending.drain(..).map(|(_, s, e)| (s, e)).collect()
    }
    fn duration(&self) -> Duration {
        Duration::from_secs_f64(60.0 / self.project.bpm / 4.0)
    }
    pub fn tick(&mut self, now: Instant) -> Vec<(Source, MidiEvent)> {
        let mut events = Vec::new();
        if self.group.as_ref().is_some_and(|g| {
            now.saturating_duration_since(g.last) >= Duration::from_millis(30)
                || now.saturating_duration_since(g.start) >= Duration::from_millis(100)
        }) {
            self.commit_group();
        }
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].0 <= now {
                let (_, s, e) = self.pending.remove(i);
                events.push((s, e));
            } else {
                i += 1;
            }
        }
        if let Some(deadline) = self.next {
            if now >= deadline {
                let duration = self.duration();
                if now.saturating_duration_since(deadline) > duration * 2 {
                    events.extend(self.pending.drain(..).map(|(_, s, e)| (s, e)));
                    let skipped = (now.saturating_duration_since(deadline).as_secs_f64()
                        / duration.as_secs_f64())
                    .floor() as u64;
                    self.step = ((self.step as u64 + skipped) % 16) as u8;
                    self.next = Some(now);
                }
                let scheduled = self.next.unwrap_or(now);
                for (t, track) in self.project.tracks.iter().enumerate() {
                    if track.muted {
                        continue;
                    }
                    let step = &track.steps[self.step as usize];
                    for note in &step.notes {
                        let source = Source::Sequencer(t as u8);
                        events.push((
                            source,
                            MidiEvent::note_on(track.channel, note.note, note.velocity),
                        ));
                        self.pending.push((
                            scheduled + duration.mul_f32(step.gate),
                            source,
                            MidiEvent::note_off(track.channel, note.note),
                        ));
                    }
                }
                self.cursor = self.step;
                self.step = (self.step + 1) % 16;
                self.next = Some(scheduled + duration);
            }
        }
        events
    }
    pub fn record(&mut self, event: MidiEvent, now: Instant) {
        if !self.recording || event.kind() != 0x90 {
            return;
        }
        if self.group.as_ref().is_some_and(|g| {
            now.saturating_duration_since(g.last) >= Duration::from_millis(30)
                || now.saturating_duration_since(g.start) >= Duration::from_millis(100)
        }) {
            self.commit_group();
        }
        let group = self.group.get_or_insert_with(|| ChordGroup {
            start: now,
            last: now,
            step: self.cursor,
            notes: vec![],
        });
        group.last = now;
        if let Some(note) = group.notes.iter_mut().find(|n| n.note == event.data1) {
            note.velocity = event.data2;
        } else {
            group.notes.push(StepNote {
                note: event.data1,
                velocity: event.data2,
            });
        }
    }
    pub fn commit_group(&mut self) {
        if let Some(group) = self.group.take() {
            let step = &mut self.project.tracks[self.armed as usize].steps[group.step as usize];
            if self.playing {
                for n in group.notes {
                    if let Some(existing) = step.notes.iter_mut().find(|v| v.note == n.note) {
                        *existing = n;
                    } else {
                        step.notes.push(n);
                    }
                }
            } else {
                step.notes = group.notes;
                self.cursor = (group.step + 1) % 16;
            }
            self.dirty = true;
        }
    }
    pub fn next_deadline(&self) -> Option<Instant> {
        self.next
            .into_iter()
            .chain(self.pending.iter().map(|p| p.0))
            .chain(self.group.as_ref().map(|g| {
                (g.last + Duration::from_millis(30)).min(g.start + Duration::from_millis(100))
            }))
            .min()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scheduling_and_recording() {
        let mut s = Sequencer::default();
        let now = Instant::now();
        s.recording = true;
        s.record(MidiEvent::note_on(0, 60, 100), now);
        s.record(
            MidiEvent::note_on(0, 64, 80),
            now + Duration::from_millis(5),
        );
        s.tick(now + Duration::from_millis(36));
        assert_eq!(s.project.tracks[0].steps[0].notes.len(), 2);
        assert_eq!(s.cursor, 1);
        s.play(now);
        assert_eq!(s.tick(now).len(), 2);
        assert_eq!(s.tick(now + Duration::from_millis(101)).len(), 2);
        assert!(s.tick(now + Duration::from_millis(102)).is_empty());
        assert!(s.stop().is_empty());
    }
    #[test]
    fn long_pause_does_not_burst_missed_notes() {
        let mut s = Sequencer::default();
        s.project.tracks[0].steps[0].notes.push(StepNote {
            note: 60,
            velocity: 100,
        });
        let now = Instant::now();
        s.play(now);
        s.tick(now);
        assert!(s.tick(now + Duration::from_secs(10)).len() <= 2);
    }
}
