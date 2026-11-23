//! Names from the meeting app itself. While a call is recorded, Cap can read
//! which participant the meeting app shows as speaking (its accessibility
//! tree: the highlighted tile, "Ana is speaking"). That timeline is lined up
//! with the voices Cap told apart in the computer's audio: a voice whose speech
//! keeps coinciding with one name, over enough separate turns, is that person.
//! Precision first: weak or mixed evidence names nobody.

use std::collections::HashMap;

use crate::names::Certainty;

/// One look at the meeting app: who it showed as speaking at `at_ms` (meeting
/// time), usually one name, none when nobody was highlighted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveSample {
    pub at_ms: u64,
    pub speaking: Vec<String>,
}

/// A stretch of the computer's audio Cap gave to one voice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoiceSpan {
    pub speaker: u32,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gates {
    /// The meeting app lights a tile a little after the voice starts and keeps
    /// it a little after it stops.
    pub lag_ms: u64,
    /// A sample stands for this long when the next one is late.
    pub max_sample_ms: u64,
    /// Of the time a voice spoke while some name was lit, the share the top
    /// name has.
    pub confident_share: f32,
    pub suggest_share: f32,
    /// Separate turns where the top name was the one lit most.
    pub confident_turns: usize,
    pub suggest_turns: usize,
    /// Share of the voice's speech the app showed anyone at all for.
    pub min_coverage: f32,
    /// Turns shorter than this carry no vote of their own.
    pub min_turn_ms: u64,
}

impl Default for Gates {
    fn default() -> Self {
        Self {
            lag_ms: 600,
            max_sample_ms: 1500,
            confident_share: 0.8,
            suggest_share: 0.6,
            confident_turns: 3,
            suggest_turns: 2,
            min_coverage: 0.25,
            min_turn_ms: 700,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActiveMatch {
    pub speaker: u32,
    pub name: String,
    pub certainty: Certainty,
    /// The top name's share of the lit time, and the turns it won.
    pub share: f32,
    pub turns: usize,
}

/// Who the meeting app's labels say is speaking, and the user's own name
/// ("Ana Ruiz (You)"). Understands "Ana is speaking", "Ana is talking",
/// "Ana, speaking", "Ana (speaking)", "Ana - speaking", "Speaking: Ana",
/// "Active speaker: Ana". Anything else is ignored.
pub fn read_labels(labels: &[String]) -> (Vec<String>, Option<String>) {
    let mut speaking: Vec<String> = Vec::new();
    let mut me = None;
    for label in labels {
        let label = label.trim();
        let lower = label.to_lowercase();
        for marker in ["(you)", "(me)"] {
            if let Some(at) = lower.find(marker)
                && let Some(name) = clean_name(&label[..at])
            {
                me = Some(name);
            }
        }
        let name = ["active speaker:", "speaking:", "now speaking:"]
            .iter()
            .find_map(|p| lower.strip_prefix(p).map(|_| &label[p.len()..]))
            .or_else(|| {
                [
                    " is speaking",
                    " is talking",
                    ", speaking",
                    " (speaking)",
                    " - speaking",
                    " – speaking",
                ]
                .iter()
                .find_map(|s| lower.find(s).map(|at| &label[..at]))
            })
            .and_then(clean_name);
        if let Some(name) = name
            && !speaking.contains(&name)
        {
            speaking.push(name);
        }
    }
    // A label for the user's own tile that also says speaking is the user.
    if let Some(me) = &me {
        speaking.retain(|n| !n.eq_ignore_ascii_case(me));
    }
    (speaking, me)
}

fn clean_name(raw: &str) -> Option<String> {
    let name = raw.trim().trim_end_matches([',', '-', '–', ':']).trim();
    let name = name
        .strip_suffix("(You)")
        .or_else(|| name.strip_suffix("(you)"))
        .unwrap_or(name)
        .trim();
    let words = name.split_whitespace().count();
    let ok = (1..=4).contains(&words)
        && name.chars().count() <= 60
        && name
            .chars()
            .all(|c| c.is_alphabetic() || " .'-’".contains(c))
        && name.chars().next().is_some_and(char::is_uppercase)
        && !["you", "me", "someone", "unknown"].contains(&name.to_lowercase().as_str());
    ok.then(|| name.to_string())
}

/// Lit intervals per name, from the samples.
fn intervals(
    samples: &[ActiveSample],
    gates: &Gates,
    skip: Option<&str>,
) -> Vec<(u64, u64, String)> {
    let mut out = Vec::new();
    for (i, sample) in samples.iter().enumerate() {
        let next = samples.get(i + 1).map_or(sample.at_ms + 500, |n| n.at_ms);
        let end = next.min(sample.at_ms + gates.max_sample_ms);
        for name in &sample.speaking {
            let name = name.trim();
            if name.is_empty() || skip.is_some_and(|s| s.eq_ignore_ascii_case(name)) {
                continue;
            }
            out.push((sample.at_ms, end, name.to_string()));
        }
    }
    out
}

fn overlap(a: (u64, u64), b: (u64, u64)) -> u64 {
    a.1.min(b.1).saturating_sub(a.0.max(b.0))
}

/// Names for the voices in `spans`, with the meeting app's lag measured from
/// the meeting itself: each candidate lag is tried and the one where voices
/// and lit names agree best is used. `self_name` is the user's own name as
/// the meeting app shows it: never given to a voice from the computer's audio.
pub fn align(
    samples: &[ActiveSample],
    spans: &[VoiceSpan],
    self_name: Option<&str>,
    gates: &Gates,
) -> Vec<ActiveMatch> {
    let mut best: Option<(u64, u64)> = None;
    for lag in [200, 400, 600, 900, 1200, 1600, 2000] {
        let score = agreement(
            samples,
            spans,
            self_name,
            &Gates {
                lag_ms: lag,
                ..*gates
            },
        );
        if best.is_none_or(|(_, b)| score > b) {
            best = Some((lag, score));
        }
    }
    let lag = best.map_or(gates.lag_ms, |(lag, _)| lag);
    align_at(
        samples,
        spans,
        self_name,
        &Gates {
            lag_ms: lag,
            ..*gates
        },
    )
}

/// How much of the voices' speech lines up with the name each voice is lit
/// with most: higher when the lag is right.
fn agreement(
    samples: &[ActiveSample],
    spans: &[VoiceSpan],
    self_name: Option<&str>,
    gates: &Gates,
) -> u64 {
    let mut lit = intervals(samples, gates, self_name);
    lit.sort_by_key(|l| l.0);
    let mut sorted: Vec<&VoiceSpan> = spans.iter().collect();
    sorted.sort_by_key(|s| s.start_ms);
    let mut by: HashMap<(u32, &str), u64> = HashMap::new();
    let mut cursor = 0;
    for span in sorted {
        let window = (span.start_ms + gates.lag_ms, span.end_ms + gates.lag_ms);
        while cursor < lit.len() && lit[cursor].1 + gates.max_sample_ms < window.0 {
            cursor += 1;
        }
        for (start, end, name) in &lit[cursor..] {
            if *start >= window.1 {
                break;
            }
            let ms = overlap(window, (*start, *end));
            if ms > 0 {
                *by.entry((span.speaker, name.as_str())).or_default() += ms;
            }
        }
    }
    let mut top: HashMap<u32, u64> = HashMap::new();
    let mut total: HashMap<u32, u64> = HashMap::new();
    for ((speaker, _), ms) in &by {
        let t = top.entry(*speaker).or_default();
        *t = (*t).max(*ms);
        *total.entry(*speaker).or_default() += ms;
    }
    // Agreeing time minus disagreeing time, so a lag that lights everyone at
    // once does not win.
    top.iter()
        .map(|(s, t)| (2 * t).saturating_sub(total[s]))
        .sum()
}

/// Names for the voices at one assumed lag.
pub fn align_at(
    samples: &[ActiveSample],
    spans: &[VoiceSpan],
    self_name: Option<&str>,
    gates: &Gates,
) -> Vec<ActiveMatch> {
    let lit = intervals(samples, gates, self_name);
    if lit.is_empty() {
        return Vec::new();
    }
    // speaker -> (speech ms, lit ms per name, turns won per name)
    #[derive(Default)]
    struct Tally {
        speech: u64,
        lit_any: u64,
        by_name: HashMap<String, u64>,
        turns: HashMap<String, usize>,
    }
    let mut tallies: HashMap<u32, Tally> = HashMap::new();
    let mut cursor = 0usize;
    let mut sorted: Vec<VoiceSpan> = spans.to_vec();
    sorted.sort_by_key(|s| s.start_ms);
    let mut lit_sorted = lit;
    lit_sorted.sort_by_key(|l| l.0);
    for span in &sorted {
        // Compare the voice with what the app showed a moment later.
        let window = (span.start_ms + gates.lag_ms, span.end_ms + gates.lag_ms);
        while cursor < lit_sorted.len() && lit_sorted[cursor].1 + gates.max_sample_ms < window.0 {
            cursor += 1;
        }
        let tally = tallies.entry(span.speaker).or_default();
        tally.speech += span.end_ms.saturating_sub(span.start_ms);
        let mut here: HashMap<&str, u64> = HashMap::new();
        let mut any: Vec<(u64, u64)> = Vec::new();
        for (start, end, name) in lit_sorted[cursor..].iter() {
            if *start >= window.1 {
                break;
            }
            let ms = overlap(window, (*start, *end));
            if ms > 0 {
                *here.entry(name.as_str()).or_default() += ms;
                any.push((
                    start.max(&window.0).to_owned(),
                    end.min(&window.1).to_owned(),
                ));
            }
        }
        any.sort();
        let mut covered = 0;
        let mut reach = 0;
        for (s, e) in any {
            let s = s.max(reach);
            if e > s {
                covered += e - s;
                reach = e;
            }
        }
        tally.lit_any += covered;
        for (name, ms) in &here {
            *tally.by_name.entry((*name).to_string()).or_default() += ms;
        }
        if span.end_ms - span.start_ms >= gates.min_turn_ms
            && let Some((name, ms)) = here
                .iter()
                .max_by_key(|(n, ms)| (**ms, std::cmp::Reverse(**n)))
        {
            let total: u64 = here.values().sum();
            if *ms * 10 >= total * 6 {
                *tally.turns.entry((*name).to_string()).or_default() += 1;
            }
        }
    }
    let mut out = Vec::new();
    for (speaker, tally) in tallies {
        let total: u64 = tally.by_name.values().sum();
        let Some((name, ms)) = tally
            .by_name
            .iter()
            .max_by_key(|(n, ms)| (**ms, std::cmp::Reverse((*n).clone())))
        else {
            continue;
        };
        if total == 0 || tally.speech == 0 {
            continue;
        }
        let share = *ms as f32 / total as f32;
        let coverage = tally.lit_any as f32 / tally.speech as f32;
        let turns = tally.turns.get(name).copied().unwrap_or(0);
        let rival_turns = tally
            .turns
            .iter()
            .filter(|(n, _)| *n != name)
            .map(|(_, t)| *t)
            .max()
            .unwrap_or(0);
        let certainty = if share >= gates.confident_share
            && turns >= gates.confident_turns
            && rival_turns * 3 <= turns
            && coverage >= gates.min_coverage
        {
            Certainty::Confident
        } else if share >= gates.suggest_share
            && turns >= gates.suggest_turns
            && rival_turns < turns
            && coverage >= gates.min_coverage / 2.
        {
            Certainty::Suggestion
        } else {
            continue;
        };
        out.push(ActiveMatch {
            speaker,
            name: name.clone(),
            certainty,
            share,
            turns,
        });
    }
    out.sort_by_key(|m| m.speaker);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(script: &[(u64, u64, &str)], every: u64) -> Vec<ActiveSample> {
        let end = script.iter().map(|s| s.1).max().unwrap_or(0);
        (0..end / every)
            .map(|i| {
                let at = i * every;
                ActiveSample {
                    at_ms: at,
                    speaking: script
                        .iter()
                        .filter(|(s, e, _)| *s <= at && at < *e)
                        .map(|(_, _, n)| n.to_string())
                        .collect(),
                }
            })
            .collect()
    }

    fn span(speaker: u32, start: u64, end: u64) -> VoiceSpan {
        VoiceSpan {
            speaker,
            start_ms: start,
            end_ms: end,
        }
    }

    #[test]
    fn a_voice_that_keeps_lining_up_with_one_tile_takes_its_name() {
        // The app lights the tile 500 ms after the voice starts.
        let lit = [
            (500, 4500, "Ana Ruiz"),
            (5500, 9500, "Ben Okafor"),
            (10500, 14500, "Ana Ruiz"),
            (15500, 19500, "Ben Okafor"),
            (20500, 24500, "Ana Ruiz"),
            (25500, 29500, "Ben Okafor"),
        ];
        let spans = [
            span(2, 0, 4000),
            span(3, 5000, 9000),
            span(2, 10000, 14000),
            span(3, 15000, 19000),
            span(2, 20000, 24000),
            span(3, 25000, 29000),
        ];
        let got = align(&samples(&lit, 500), &spans, Some("Me"), &Gates::default());
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.iter().all(|m| m.certainty == Certainty::Confident));
        assert_eq!(got[0].name, "Ana Ruiz");
        assert_eq!(got[1].name, "Ben Okafor");
    }

    #[test]
    fn a_voice_that_is_two_people_or_too_little_names_nobody() {
        let lit = [
            (0, 4000, "Ana"),
            (5000, 9000, "Ben"),
            (10000, 14000, "Ana"),
            (15000, 19000, "Ben"),
        ];
        let mixed = [
            span(2, 0, 4000),
            span(2, 5000, 9000),
            span(2, 10000, 14000),
            span(2, 15000, 19000),
        ];
        assert!(align(&samples(&lit, 500), &mixed, None, &Gates::default()).is_empty());
        let once = [span(4, 0, 4000)];
        let got = align(&samples(&lit, 500), &once, None, &Gates::default());
        assert!(
            got.iter().all(|m| m.certainty != Certainty::Confident),
            "{got:?}"
        );
    }

    #[test]
    fn the_users_own_tile_never_names_a_voice_from_the_call() {
        let lit = [
            (0, 4000, "Me"),
            (5000, 9000, "Me"),
            (10000, 14000, "Me"),
            (15000, 19000, "Me"),
        ];
        let spans = [
            span(2, 0, 4000),
            span(2, 5000, 9000),
            span(2, 10000, 14000),
            span(2, 15000, 19000),
        ];
        assert!(align(&samples(&lit, 500), &spans, Some("me"), &Gates::default()).is_empty());
    }

    #[test]
    fn labels_say_who_is_speaking_and_who_the_user_is() {
        let labels: Vec<String> = [
            "Ana Ruiz is speaking",
            "Ben Okafor, speaking",
            "Speaking: Kwame",
            "Dana Lee (You)",
            "Dana Lee (You), speaking",
            "Mute microphone",
            "Speaking time limit is 5 minutes",
            "3 people speaking",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (speaking, me) = read_labels(&labels);
        assert_eq!(me.as_deref(), Some("Dana Lee"));
        assert_eq!(speaking, vec!["Ana Ruiz", "Ben Okafor", "Kwame"]);
    }

    #[test]
    fn an_hour_long_call_aligns_in_milliseconds() {
        let mut lit = Vec::new();
        let mut spans = Vec::new();
        for i in 0..1800u64 {
            let name = if i % 2 == 0 { "Ana" } else { "Ben" };
            lit.push((i * 2000 + 500, i * 2000 + 2300, name));
            spans.push(span(2 + (i % 2) as u32, i * 2000, i * 2000 + 1800));
        }
        let samples = samples(&lit, 500);
        let started = std::time::Instant::now();
        let got = align(&samples, &spans, None, &Gates::default());
        let took = started.elapsed();
        assert_eq!(got.len(), 2);
        assert!(
            took < std::time::Duration::from_millis(500),
            "{took:?} (debug build)"
        );
    }

    #[test]
    fn one_person_split_into_two_voices_gives_both_the_name() {
        let lit = [
            (0, 4000, "Ana"),
            (5000, 9000, "Ana"),
            (10000, 14000, "Ana"),
            (15000, 19000, "Ana"),
            (20000, 24000, "Ana"),
            (25000, 29000, "Ana"),
        ];
        let spans = [
            span(2, 0, 4000),
            span(5, 5000, 9000),
            span(2, 10000, 14000),
            span(5, 15000, 19000),
            span(2, 20000, 24000),
            span(5, 25000, 29000),
        ];
        let got = align(&samples(&lit, 500), &spans, None, &Gates::default());
        assert_eq!(got.iter().filter(|m| m.name == "Ana").count(), 2);
    }

    /// Real diarisation (W's harness output for the meet and AMI sets) against
    /// a simulated meeting-app timeline built from the true speaker times,
    /// under lag, slow polling, tiles left lit, flicker and dropouts.
    /// ACTIVE_EVAL=<file of "hyp.json|truth.rttm" lines>
    /// cargo test -p cap-meetings active_eval -- --ignored --nocapture
    #[test]
    #[ignore]
    fn active_eval() {
        let Ok(list) = std::env::var("ACTIVE_EVAL") else {
            return;
        };
        struct Scenario {
            name: &'static str,
            lag: u64,
            hold: u64,
            poll: u64,
            flicker: u32,
            drop: u32,
        }
        let scenarios = [
            Scenario {
                name: "good",
                lag: 400,
                hold: 800,
                poll: 500,
                flicker: 0,
                drop: 5,
            },
            Scenario {
                name: "slow",
                lag: 900,
                hold: 1500,
                poll: 1000,
                flicker: 5,
                drop: 10,
            },
            Scenario {
                name: "bad",
                lag: 1500,
                hold: 2000,
                poll: 1000,
                flicker: 15,
                drop: 20,
            },
        ];
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut rand = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 100) as u32
        };
        let files: Vec<(String, String)> = std::fs::read_to_string(list)
            .unwrap()
            .lines()
            .filter_map(|l| {
                l.split_once('|')
                    .map(|(a, b)| (a.to_string(), b.to_string()))
            })
            .collect();
        for sc in &scenarios {
            let (mut voices, mut conf, mut conf_ok, mut sug, mut sug_ok) = (0, 0, 0, 0, 0);
            let mut wrong = Vec::new();
            for (hyp, truth) in &files {
                let hyp: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(hyp).unwrap()).unwrap();
                let users: Vec<u64> = hyp["final"]["speakers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|s| s["isUser"].as_bool() == Some(true))
                    .map(|s| s["id"].as_u64().unwrap())
                    .collect();
                let mut spans = Vec::new();
                for seg in hyp["final"]["segments"].as_array().unwrap() {
                    if seg["track"] != "system" {
                        continue;
                    }
                    for sp in seg["spans"].as_array().unwrap() {
                        if sp["echo"].as_bool() == Some(true) {
                            continue;
                        }
                        let id = sp["speaker"].as_u64().unwrap();
                        if users.contains(&id) {
                            continue;
                        }
                        spans.push(VoiceSpan {
                            speaker: id as u32,
                            start_ms: sp["startMs"].as_u64().unwrap(),
                            end_ms: sp["endMs"].as_u64().unwrap(),
                        });
                    }
                }
                let truth: Vec<(u64, u64, String)> = std::fs::read_to_string(truth)
                    .unwrap()
                    .lines()
                    .filter_map(|l| {
                        let f: Vec<&str> = l.split_whitespace().collect();
                        let start = (f.get(3)?.parse::<f64>().ok()? * 1000.) as u64;
                        let dur = (f.get(4)?.parse::<f64>().ok()? * 1000.) as u64;
                        let who = f.get(7)?.to_string();
                        (who != "USER").then_some((start, start + dur, who))
                    })
                    .collect();
                let roster: Vec<String> = {
                    let mut r: Vec<String> = truth.iter().map(|t| t.2.clone()).collect();
                    r.sort();
                    r.dedup();
                    r
                };
                let end = truth.iter().map(|t| t.1).max().unwrap_or(0) + 3000;
                let mut samples = Vec::new();
                let mut at = 0;
                while at < end {
                    let mut who: Option<String> = truth
                        .iter()
                        .filter(|(s, e, _)| *s + sc.lag <= at && at < *e + sc.hold)
                        .max_by_key(|(s, _, _)| *s)
                        .map(|t| t.2.clone());
                    let r = rand();
                    if r < sc.drop {
                        who = None;
                    } else if who.is_some() && r < sc.drop + sc.flicker {
                        who = Some(roster[(rand() as usize) % roster.len()].clone());
                    }
                    samples.push(ActiveSample {
                        at_ms: at,
                        speaking: who.into_iter().collect(),
                    });
                    at += sc.poll;
                }
                let got = align(&samples, &spans, None, &Gates::default());
                let mut speakers: Vec<u32> = spans.iter().map(|s| s.speaker).collect();
                speakers.sort();
                speakers.dedup();
                voices += speakers.len();
                for m in got {
                    // The person this voice mostly is.
                    let mut by: HashMap<&str, u64> = HashMap::new();
                    for s in spans.iter().filter(|s| s.speaker == m.speaker) {
                        for t in &truth {
                            *by.entry(t.2.as_str()).or_default() +=
                                overlap((s.start_ms, s.end_ms), (t.0, t.1));
                        }
                    }
                    let truly = by
                        .iter()
                        .max_by_key(|(_, ms)| **ms)
                        .map(|(n, _)| n.to_string());
                    let ok = truly.as_deref() == Some(m.name.as_str());
                    match m.certainty {
                        Certainty::Confident => {
                            conf += 1;
                            conf_ok += usize::from(ok);
                            if !ok {
                                wrong.push(format!(
                                    "{} -> {} (truly {:?})",
                                    m.speaker, m.name, truly
                                ));
                            }
                        }
                        Certainty::Suggestion => {
                            sug += 1;
                            sug_ok += usize::from(ok);
                        }
                    }
                }
            }
            let pct = |a: usize, b: usize| {
                if b == 0 {
                    100.
                } else {
                    100. * a as f64 / b as f64
                }
            };
            println!(
                "ACTIVE {:<5} files {} voices {} | confident precision {:.1}% ({}/{}) recall {:.1}% | suggestions {:.1}% ({}/{}) | wrong {:?}",
                sc.name,
                files.len(),
                voices,
                pct(conf_ok, conf),
                conf_ok,
                conf,
                pct(conf_ok, voices),
                pct(sug_ok, sug),
                sug_ok,
                sug,
                wrong
            );
        }
    }
}
