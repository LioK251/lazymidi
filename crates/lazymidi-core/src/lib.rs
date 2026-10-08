pub mod analog;
pub mod config;
pub mod devices;
pub mod engine;
pub mod latency;
pub mod midi;
pub mod platform;
pub mod routing;
pub mod runtime;
pub mod sequencer;

pub type Result<T> = std::result::Result<T, String>;

pub mod qwerty;
