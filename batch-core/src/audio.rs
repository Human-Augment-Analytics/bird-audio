//! Cross-format recording duration used by every effort denominator.

use std::fs::File;
use std::path::Path;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;

/// Read duration from WAV, FLAC, MP3, and other supported audio headers.
///
/// The format is detected from file contents. Zero-length, unreadable, and
/// malformed files return `None`, allowing callers to disclose their fallback.
pub fn audio_duration_hours(path: &Path) -> Option<f64> {
    let source = Box::new(File::open(path).ok()?);
    let stream = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let mut format = get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?
        .format;
    let track = format.default_track()?;
    let track_id = track.id;
    let time_base = track.codec_params.time_base?;
    let mut frames = 0_u64;
    loop {
        match format.next_packet() {
            Ok(packet) if packet.track_id() == track_id => {
                frames = frames.max(packet.ts().saturating_add(packet.dur()));
            }
            Ok(_) => {}
            Err(symphonia::core::errors::Error::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(_) => return None,
        }
    }
    let time = time_base.calc_time(frames);
    let seconds = time.seconds as f64 + time.frac;
    (seconds.is_finite() && seconds > 0.0).then_some(seconds / 3600.0)
}
