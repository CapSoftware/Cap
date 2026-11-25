//! Linux: which output a meeting's computer audio is read from. The call
//! may play through an output that is not the default (a headset chosen in
//! the call app, the speakers still the default), and the default output's
//! monitor then hears nothing of it. The call app is the one that both
//! records (the microphone) and plays: its output is followed, otherwise the
//! default. Music playing elsewhere is never taken for the call.

/// A stream as `pactl list sink-inputs` / `source-outputs` describes it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stream {
    /// The sink (or source) index it is connected to.
    pub device: u32,
    pub corked: bool,
    pub pid: Option<u32>,
    pub app: String,
}

/// Parses `LC_ALL=C pactl list sink-inputs` (`owner` "Sink") or
/// `source-outputs` (`owner` "Source").
pub fn parse_streams(text: &str, owner: &str) -> Vec<Stream> {
    let owner = format!("{owner}:");
    let mut out: Vec<Stream> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Sink Input #") || trimmed.starts_with("Source Output #") {
            out.push(Stream::default());
            continue;
        }
        let Some(stream) = out.last_mut() else {
            continue;
        };
        if let Some(rest) = trimmed.strip_prefix(owner.as_str()) {
            stream.device = rest.trim().parse().unwrap_or(u32::MAX);
        } else if let Some(rest) = trimmed.strip_prefix("Corked:") {
            stream.corked = rest.trim() == "yes";
        } else if let Some(rest) = trimmed.strip_prefix("application.process.id = ") {
            stream.pid = rest.trim().trim_matches('"').parse().ok();
        } else if let Some(rest) = trimmed.strip_prefix("application.name = ") {
            stream.app = rest.trim().trim_matches('"').to_string();
        }
    }
    out
}

/// Parses `pactl list short sinks`: index and name.
pub fn parse_sinks(text: &str) -> Vec<(u32, String)> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let index = fields.next()?.trim().parse().ok()?;
            let name = fields.next()?.trim().to_string();
            Some((index, name))
        })
        .collect()
}

/// The default sink from `LC_ALL=C pactl info`.
pub fn parse_default_sink(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.trim().strip_prefix("Default Sink:"))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// The sink to read, or `None` for the default output. `ours` is Cap's own
/// process, whose streams (its sounds, its own recording) never count.
pub fn choose(
    sinks: &[(u32, String)],
    default: Option<&str>,
    playing: &[Stream],
    recording: &[Stream],
    ours: u32,
) -> Option<String> {
    let foreign = |s: &&Stream| s.pid != Some(ours) && s.app != "Cap";
    let playing: Vec<&Stream> = playing
        .iter()
        .filter(|s| !s.corked)
        .filter(foreign)
        .collect();
    let callers: Vec<u32> = recording
        .iter()
        .filter(foreign)
        .filter_map(|s| s.pid)
        .collect();
    let name = |index: u32| {
        sinks
            .iter()
            .find(|(i, _)| *i == index)
            .map(|(_, name)| name.clone())
    };
    // One process can play several things: a browser runs every tab's audio
    // in one service, so a music tab on a headset and a call on the speakers
    // share it. Only when everything the calling programs play goes to one
    // output other than the default is that output followed.
    let mut outputs: Vec<String> = playing
        .iter()
        .filter(|s| s.pid.is_some_and(|pid| callers.contains(&pid)))
        .filter_map(|s| name(s.device))
        .collect();
    outputs.sort();
    outputs.dedup();
    match outputs.as_slice() {
        [only] if Some(only.as_str()) != default => Some(only.clone()),
        _ => None,
    }
}

/// Whether Cap's reader (the `parec` with `pid`) records `output`'s monitor.
/// PulseAudio moves a recording off a monitor when the default input
/// changes: a headset's microphone gone leaves the speakers' monitor as the
/// default input, and when the headset comes back the reader moves to its
/// microphone with every other recording there. `None` when pactl does not
/// say (the reader is not listed yet).
pub fn reader_on_monitor(
    sources: &[(u32, String)],
    recording: &[Stream],
    pid: u32,
    output: &str,
) -> Option<bool> {
    let ours = recording.iter().find(|s| s.pid == Some(pid))?;
    let (_, name) = sources.iter().find(|(index, _)| *index == ours.device)?;
    Some(*name == format!("{output}.monitor"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SINK_INPUTS: &str = "Sink Input #12\n\tDriver: protocol-native.c\n\tSink: 1\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Chromium\"\n\t\tapplication.process.id = \"4100\"\n\nSink Input #13\n\tSink: 0\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Spotify\"\n\t\tapplication.process.id = \"5200\"\n";
    const SOURCE_OUTPUTS: &str = "Source Output #7\n\tSource: 3\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Chromium\"\n\t\tapplication.process.id = \"4100\"\n\nSource Output #8\n\tSource: 2\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Cap\"\n\t\tapplication.process.id = \"900\"\n";

    fn sinks() -> Vec<(u32, String)> {
        parse_sinks(
            "0\troom\tmodule-null-sink.c\ts16le 2ch 44100Hz\tRUNNING\n1\theadset\tmodule-null-sink.c\ts16le 2ch 44100Hz\tRUNNING\n",
        )
    }

    #[test]
    fn parses_what_pactl_prints() {
        let playing = parse_streams(SINK_INPUTS, "Sink");
        assert_eq!(
            playing[0],
            Stream {
                device: 1,
                corked: false,
                pid: Some(4100),
                app: "Chromium".into()
            }
        );
        assert_eq!(playing[1].device, 0);
        let recording = parse_streams(SOURCE_OUTPUTS, "Source");
        assert_eq!(recording[1].app, "Cap");
        assert_eq!(sinks()[1], (1, "headset".to_string()));
        assert_eq!(
            parse_default_sink(
                "Server Name: pulseaudio\nDefault Sink: room\nDefault Source: mic\n"
            ),
            Some("room".into())
        );
    }

    #[test]
    fn the_call_is_followed_to_the_headset_even_with_music_on_the_speakers() {
        let playing = parse_streams(SINK_INPUTS, "Sink");
        let recording = parse_streams(SOURCE_OUTPUTS, "Source");
        assert_eq!(
            choose(&sinks(), Some("room"), &playing, &recording, 900),
            Some("headset".into())
        );
    }

    #[test]
    fn a_call_on_the_default_output_stays_on_the_default() {
        let playing = vec![Stream {
            device: 0,
            pid: Some(4100),
            ..Stream::default()
        }];
        let recording = vec![Stream {
            device: 3,
            pid: Some(4100),
            ..Stream::default()
        }];
        assert_eq!(
            choose(&sinks(), Some("room"), &playing, &recording, 900),
            None
        );
    }

    #[test]
    fn a_browser_playing_to_two_outputs_keeps_the_default() {
        // One audio service for every tab: the call on the speakers, a music
        // tab on the headset, the service recording the microphone.
        let playing = vec![
            Stream {
                device: 0,
                pid: Some(4100),
                ..Stream::default()
            },
            Stream {
                device: 1,
                pid: Some(4100),
                ..Stream::default()
            },
        ];
        let recording = vec![Stream {
            device: 3,
            pid: Some(4100),
            ..Stream::default()
        }];
        assert_eq!(
            choose(&sinks(), Some("room"), &playing, &recording, 900),
            None
        );
        // Listed the other way round: still the default.
        let reversed: Vec<Stream> = playing.into_iter().rev().collect();
        assert_eq!(
            choose(&sinks(), Some("room"), &reversed, &recording, 900),
            None
        );
    }

    #[test]
    fn with_no_call_found_the_default_is_read() {
        // Music in headphones during a meeting in the room is not the call.
        let playing = vec![Stream {
            device: 1,
            pid: Some(77),
            ..Stream::default()
        }];
        assert_eq!(choose(&sinks(), Some("room"), &playing, &[], 900), None);
    }

    /// What pactl says (LC_ALL=C) after a headset's microphone went away and
    /// came back: the speakers' monitor was the default input meanwhile, and
    /// PulseAudio moved Cap's reader to the returning microphone with it.
    #[test]
    fn the_monitor_reader_moved_to_a_returning_microphone_is_noticed() {
        let sources = parse_sinks(
            "0\troom.monitor\tmodule-null-sink.c\ts16le 2ch 44100Hz\tIDLE\n\
             1\tmicsink.monitor\tmodule-null-sink.c\ts16le 2ch 44100Hz\tRUNNING\n\
             3\tmic\tmodule-remap-source.c\ts16le 2ch 44100Hz\tRUNNING\n",
        );
        let outputs = |cap_source: u32| {
            parse_streams(
                &format!(
                    "Source Output #0\n\tDriver: protocol-native.c\n\tSource: 1\n\tProperties:\n\
                     \t\tmedia.name = \"Remapped Stream\"\n\
                     Source Output #4\n\tDriver: protocol-native.c\n\tSource: {cap_source}\n\tProperties:\n\
                     \t\tmedia.name = \"Cap meeting audio\"\n\t\tapplication.process.id = \"25671\"\n"
                ),
                "Source",
            )
        };
        assert_eq!(
            reader_on_monitor(&sources, &outputs(3), 25671, "room"),
            Some(false)
        );
        assert_eq!(
            reader_on_monitor(&sources, &outputs(0), 25671, "room"),
            Some(true)
        );
        // Followed to the headset: the room's monitor is the wrong one.
        assert_eq!(
            reader_on_monitor(&sources, &outputs(0), 25671, "micsink"),
            Some(false)
        );
        assert_eq!(
            reader_on_monitor(&sources, &outputs(0), 1, "room"),
            None,
            "another process's stream says nothing about Cap's"
        );
    }

    #[test]
    fn caps_own_and_paused_streams_never_count() {
        let playing = vec![
            Stream {
                device: 1,
                pid: Some(900),
                ..Stream::default()
            },
            Stream {
                device: 1,
                corked: true,
                pid: Some(77),
                ..Stream::default()
            },
            Stream {
                device: 1,
                app: "Cap".into(),
                ..Stream::default()
            },
        ];
        assert_eq!(choose(&sinks(), Some("room"), &playing, &[], 900), None);
        assert_eq!(choose(&sinks(), Some("room"), &[], &[], 900), None);
    }
}
