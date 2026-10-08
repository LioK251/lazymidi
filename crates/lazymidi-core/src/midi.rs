use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiEvent {
    pub status: u8,
    pub data1: u8,
    pub data2: u8,
}

impl MidiEvent {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let status = *bytes.first()?;
        if !(0x80..0xf0).contains(&status) {
            return None;
        }
        let len = if status & 0xf0 == 0xc0 || status & 0xf0 == 0xd0 {
            2
        } else {
            3
        };
        if bytes.len() != len || bytes[1..].iter().any(|b| *b > 127) {
            return None;
        }
        let mut event = Self {
            status,
            data1: bytes[1],
            data2: *bytes.get(2).unwrap_or(&0),
        };
        if event.kind() == 0x90 && event.data2 == 0 {
            event.status = 0x80 | event.channel();
        }
        Some(event)
    }
    pub fn note_on(channel: u8, note: u8, velocity: u8) -> Self {
        Self {
            status: 0x90 | channel,
            data1: note,
            data2: velocity.max(1),
        }
    }
    pub fn note_off(channel: u8, note: u8) -> Self {
        Self {
            status: 0x80 | channel,
            data1: note,
            data2: 0,
        }
    }
    pub fn cc(channel: u8, cc: u8, value: u8) -> Self {
        Self {
            status: 0xb0 | channel,
            data1: cc,
            data2: value,
        }
    }
    pub fn channel(self) -> u8 {
        self.status & 0x0f
    }
    pub fn kind(self) -> u8 {
        self.status & 0xf0
    }
    pub fn bytes(self) -> ([u8; 3], usize) {
        (
            [self.status, self.data1, self.data2],
            if matches!(self.kind(), 0xc0 | 0xd0) {
                2
            } else {
                3
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalize_and_reject_invalid_messages() {
        assert_eq!(
            MidiEvent::parse(&[0x92, 60, 0]),
            Some(MidiEvent::note_off(2, 60))
        );
        for bytes in [
            vec![],
            vec![0x90, 60],
            vec![0x90, 128, 1],
            vec![0xf8],
            vec![0xf0, 0, 0],
        ] {
            assert!(MidiEvent::parse(&bytes).is_none());
        }
        assert_eq!(MidiEvent::parse(&[0xc0, 5]).unwrap().bytes().1, 2);
    }
}
