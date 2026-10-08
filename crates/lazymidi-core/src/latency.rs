use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const WINDOW: usize = 512;

#[derive(Clone, Debug, Serialize)]
pub struct Summary {
    pub count: u64,
    pub samples: usize,
    pub p50_us: f64,
    pub p95_us: f64,
    pub p99_us: f64,
    pub max_us: f64,
}

struct Timings {
    values: [AtomicU64; WINDOW],
    count: AtomicU64,
    max: AtomicU64,
}
impl Default for Timings {
    fn default() -> Self {
        Self {
            values: std::array::from_fn(|_| AtomicU64::new(0)),
            count: AtomicU64::new(0),
            max: AtomicU64::new(0),
        }
    }
}
impl Timings {
    fn record(&self, elapsed: Duration) {
        let nanos = elapsed.as_nanos().clamp(1, u64::MAX as u128) as u64;
        let index = self.count.fetch_add(1, Ordering::Relaxed) as usize % WINDOW;
        self.values[index].store(nanos, Ordering::Relaxed);
        self.max.fetch_max(nanos, Ordering::Relaxed);
    }
    fn summary(&self) -> Option<Summary> {
        let count = self.count.load(Ordering::Relaxed);
        let mut values: Vec<_> = self
            .values
            .iter()
            .take(count.min(WINDOW as u64) as usize)
            .map(|v| v.load(Ordering::Relaxed))
            .filter(|v| *v > 0)
            .collect();
        if values.is_empty() {
            return None;
        }
        values.sort_unstable();
        let percentile = |p: usize| values[(values.len() * p).div_ceil(100) - 1] as f64 / 1000.0;
        Some(Summary {
            count,
            samples: values.len(),
            p50_us: percentile(50),
            p95_us: percentile(95),
            p99_us: percentile(99),
            max_us: self.max.load(Ordering::Relaxed) as f64 / 1000.0,
        })
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    #[cfg(feature = "wooting")]
    SdkRead = 0,
    MidiQueue = 1,
    AnalogQueue = 2,
    KeyboardQueue = 3,
    NativeSend = 4,
    MidiToSend = 5,
    AnalogToSend = 6,
    #[cfg(feature = "wooting")]
    AnalogSampleInterval = 7,
}

#[derive(Default)]
pub struct Metrics {
    stages: [Timings; 8],
}
impl Metrics {
    pub(crate) fn record(&self, stage: Stage, elapsed: Duration) {
        self.stages[stage as usize].record(elapsed);
    }
    // Collection/sorting runs on diagnostics callers, never the MIDI engine/output thread.
    pub fn snapshot(&self) -> BTreeMap<String, Summary> {
        [
            "sdk_read",
            "midi_input_queue",
            "analog_input_queue",
            "keyboard_output_queue",
            "native_send",
            "midi_to_send",
            "analog_to_send",
            "analog_sample_interval",
        ]
        .into_iter()
        .zip(&self.stages)
        .filter_map(|(name, timings)| timings.summary().map(|s| (name.into(), s)))
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_window_is_bounded_and_max_is_retained() {
        let metrics = Metrics::default();
        assert!(metrics.snapshot().is_empty());
        metrics.record(Stage::NativeSend, Duration::from_micros(999));
        for _ in 0..600 {
            metrics.record(Stage::NativeSend, Duration::from_micros(10));
        }
        let summary = &metrics.snapshot()["native_send"];
        assert_eq!(summary.count, 601);
        assert_eq!(summary.samples, WINDOW);
        assert_eq!(summary.p99_us, 10.0);
        assert_eq!(summary.max_us, 999.0);
    }
}
