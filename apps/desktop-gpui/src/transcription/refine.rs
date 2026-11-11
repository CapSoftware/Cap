//! The second, background pass of transcription. The first pass shows its
//! transcript as soon as the engine is done; this pass re-decodes speech the
//! engine missed, aligns every word against the audio and snaps word edges
//! to pauses, then hands back refined captions for the editor to swap in.
//!
//! A pending request is kept beside the project, so a refinement interrupted
//! by closing the editor resumes when the project opens again, and a finished
//! one never runs twice.

use std::{
    collections::HashMap,
    ops::Range,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use cap_project::{CaptionSegment, CaptionWord, ProjectConfiguration};
use serde::{Deserialize, Serialize};

use super::{
    REFINEMENT_THREADS, TUNING, TranscriptionAudioOffset, Tuning, VerbatimOptions, align,
    aligns_words_in, caption_segments_from_groups, finish_words_tuned,
    invalidate_whisper_cache_for_path, is_parakeet_model, load_word_aligner,
    lock_transcription_worker_slot, model_files_present, model_path, read_wav_16k_mono,
    restore_source_timestamps, with_transcription_audio,
};

const REQUEST_FILE: &str = "caption-refinement.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinementRequest {
    pub model: String,
    pub language: String,
    /// The source ranges the first pass transcribed, so refinement hears the
    /// same audio even after the timeline has been cut.
    pub ranges: Vec<[f64; 2]>,
    /// The words-per-caption size the first pass used, so refined captions
    /// are chunked the same way. Requests saved before the setting existed
    /// read as the default.
    #[serde(default = "default_segment_words")]
    pub segment_words: usize,
}

fn default_segment_words() -> usize {
    cap_project::TARGET_CAPTION_WORDS_PER_SEGMENT
}

impl RefinementRequest {
    pub fn new(model: &str, language: &str, ranges: &[Range<f64>], segment_words: usize) -> Self {
        Self {
            model: model.to_string(),
            language: language.to_string(),
            ranges: ranges
                .iter()
                .map(|range| [range.start, range.end])
                .collect(),
            segment_words,
        }
    }
}

fn request_path(project_path: &Path) -> PathBuf {
    project_path.join(REQUEST_FILE)
}

pub fn save_refinement_request(
    project_path: &Path,
    request: &RefinementRequest,
) -> Result<(), String> {
    let path = request_path(project_path);
    let staging = path.with_extension("json.partial");
    let json = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    std::fs::write(&staging, json)
        .and_then(|()| std::fs::rename(&staging, &path))
        .map_err(|error| format!("Failed to save the caption refinement request: {error}"))
}

pub fn refinement_request(project_path: &Path) -> Option<RefinementRequest> {
    let bytes = std::fs::read(request_path(project_path)).ok()?;
    serde_json::from_slice(&bytes)
        .inspect_err(|error| {
            tracing::warn!("Ignoring a broken caption refinement request: {error}")
        })
        .ok()
}

pub fn clear_refinement_request(project_path: &Path) {
    let path = request_path(project_path);
    if let Err(error) = std::fs::remove_file(&path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("Failed to remove {}: {error}", path.display());
    }
}

/// Lowers the calling thread below the editor's: utility QoS on macOS, nice
/// 10 on Linux, below normal on Windows. Threads it starts afterwards inherit
/// the lower priority.
pub fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS as _, libc::gettid() as _, 10);
    }
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

type WordKey = (String, u32, u32);

fn word_key(word: &CaptionWord) -> WordKey {
    (word.text.clone(), word.start.to_bits(), word.end.to_bits())
}

fn same_word(a: &CaptionWord, b: &CaptionWord) -> bool {
    a.text == b.text && a.start.to_bits() == b.start.to_bits() && a.end.to_bits() == b.end.to_bits()
}

fn words_signature(segments: &[CaptionSegment]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    segments.len().hash(&mut hasher);
    for segment in segments {
        segment.words.len().hash(&mut hasher);
        for word in &segment.words {
            word_key(word).hash(&mut hasher);
        }
    }
    hasher.finish()
}

#[derive(Debug, Clone)]
pub struct RefinedCaptions {
    input_signature: u64,
    segments: Vec<CaptionSegment>,
    /// Each input word's refined times, for captions edited while the
    /// refinement ran.
    retimed: HashMap<WordKey, (f32, f32)>,
}

impl RefinedCaptions {
    pub fn new(input: &[CaptionSegment], segments: Vec<CaptionSegment>) -> Self {
        Self {
            input_signature: words_signature(input),
            retimed: match_retimes(input, &segments),
            segments,
        }
    }
}

/// Pairs each input word with the refined word that has its text, in order.
/// Refinement only inserts words, so an input word missing from the output
/// is skipped without moving on.
fn match_retimes(
    input: &[CaptionSegment],
    refined: &[CaptionSegment],
) -> HashMap<WordKey, (f32, f32)> {
    let refined: Vec<&CaptionWord> = refined.iter().flat_map(|segment| &segment.words).collect();
    let mut retimed = HashMap::new();
    let mut next = 0;
    for word in input.iter().flat_map(|segment| &segment.words) {
        let Some(offset) = refined[next..]
            .iter()
            .position(|candidate| candidate.text == word.text)
        else {
            continue;
        };
        let found = refined[next + offset];
        retimed.insert(word_key(word), (found.start, found.end));
        next += offset + 1;
    }
    retimed
}

/// Swaps refined word times into the project. Captions untouched since the
/// refinement started are replaced whole, recovered words included; edited
/// captions keep their edits and only the words still as transcribed move.
/// Clips are never touched, so cuts stay where they are.
pub fn apply_refined_captions(
    project: &mut ProjectConfiguration,
    refined: &RefinedCaptions,
    recording_durations: &[f64],
) -> bool {
    let Some(captions) = project
        .captions
        .as_mut()
        .filter(|captions| captions.source_timed)
    else {
        return false;
    };
    if words_signature(&captions.segments) == refined.input_signature {
        captions.segments = refined.segments.clone();
    } else {
        let mut changed = false;
        for segment in &mut captions.segments {
            let mut moved = false;
            for word in &mut segment.words {
                if let Some(&(start, end)) = refined.retimed.get(&word_key(word))
                    && (word.start, word.end) != (start, end)
                {
                    (word.start, word.end) = (start, end);
                    moved = true;
                }
            }
            if moved {
                align::keep_order(&mut segment.words);
                if let (Some(first), Some(last)) = (segment.words.first(), segment.words.last()) {
                    (segment.start, segment.end) = (first.start, last.end);
                }
                changed = true;
            }
        }
        if !changed {
            return false;
        }
    }
    cap_project::synchronize_captions(project, recording_durations);
    true
}

/// Puts words back into the groups they came from; a recovered word joins
/// the group of the word before it.
fn regroup(groups: &[Vec<CaptionWord>], words: Vec<CaptionWord>) -> Vec<Vec<CaptionWord>> {
    let originals: Vec<(usize, &CaptionWord)> = groups
        .iter()
        .enumerate()
        .flat_map(|(group, words)| words.iter().map(move |word| (group, word)))
        .collect();
    let mut regrouped: Vec<Vec<CaptionWord>> = vec![Vec::new(); groups.len().max(1)];
    let mut next = 0;
    let mut group = 0;
    for word in words {
        if let Some(&(original_group, original)) = originals.get(next)
            && same_word(original, &word)
        {
            group = original_group;
            next += 1;
        }
        regrouped[group].push(word);
    }
    regrouped
}

pub(super) struct Pass<'a> {
    pub samples: &'a [f32],
    pub language: &'a str,
    pub options: &'a VerbatimOptions,
    pub tuning: &'a Tuning,
    pub stop: &'a AtomicBool,
}

/// Refines first-pass word groups. `recover` re-decodes unheard speech and
/// must release its engine before returning, because the aligner loads only
/// afterwards. `None` once `stop` is set.
pub(super) fn refine_groups<A: align::Emissions>(
    pass: &Pass<'_>,
    groups: Vec<Vec<CaptionWord>>,
    recover: impl FnOnce(&mut Vec<CaptionWord>),
    aligner: impl FnOnce() -> Option<A>,
) -> Option<Vec<Vec<CaptionWord>>> {
    let groups = if pass.options.recover_speech {
        let mut words: Vec<CaptionWord> = groups.iter().flatten().cloned().collect();
        recover(&mut words);
        regroup(&groups, words)
    } else {
        groups
    };
    if pass.stop.load(Ordering::Relaxed) {
        return None;
    }
    let mut aligner = (pass.options.align_words && aligns_words_in(pass.language, &groups))
        .then(aligner)
        .flatten();
    let refined = finish_words_tuned(
        groups,
        pass.samples,
        pass.options,
        aligner
            .as_mut()
            .map(|aligner| aligner as &mut dyn align::Emissions),
        pass.tuning,
        pass.stop,
    );
    (!pass.stop.load(Ordering::Relaxed)).then_some(refined)
}

const MAX_RANGES: usize = 4096;

/// The request's ranges, read from a file beside the project, clamped to the
/// recording and merged so no audio is extracted twice.
fn sanitized_ranges(
    request: &RefinementRequest,
    recording_durations: &[f64],
) -> Result<Vec<Range<f64>>, String> {
    let total: f64 = recording_durations.iter().sum();
    let mut ranges: Vec<Range<f64>> = request
        .ranges
        .iter()
        .filter(|range| range.iter().all(|time| time.is_finite()))
        .map(|&[start, end]| start.max(0.0)..end.min(total))
        .filter(|range| range.end > range.start)
        .collect();
    ranges.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<Range<f64>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    if merged.is_empty() || merged.len() > MAX_RANGES {
        return Err("The caption refinement request does not match the recording".to_string());
    }
    Ok(merged)
}

fn to_concatenated_time(time: f32, offsets: &[TranscriptionAudioOffset]) -> Option<f32> {
    let time = f64::from(time);
    offsets
        .iter()
        .find(|offset| {
            time >= offset.source_start - 1e-3 && time <= offset.source_start + offset.length + 1e-3
        })
        .map(|offset| (offset.concatenated_start + (time - offset.source_start).max(0.0)) as f32)
}

/// Refines `input`, the project's source-timed captions, by hearing the same
/// audio the first pass heard. Runs on the calling thread with each model on
/// [`REFINEMENT_THREADS`] threads, one model loaded at a time. `Ok(None)`
/// once `stop` is set.
pub fn refine_blocking(
    project_path: &Path,
    request: &RefinementRequest,
    input: &[CaptionSegment],
    recording_durations: &[f64],
    runtime: Option<tokio::runtime::Handle>,
    stop: &AtomicBool,
) -> Result<Option<RefinedCaptions>, String> {
    let model = request.model.as_str();
    if !model_files_present(model) {
        return Err(format!("The {model} model is no longer downloaded"));
    }
    let model_file = model_path(model);
    let ranges = sanitized_ranges(request, recording_durations)?;
    let _guard = lock_transcription_worker_slot();
    if stop.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let options = VerbatimOptions::default();
    let segments = with_transcription_audio(
        project_path,
        &ranges,
        recording_durations,
        stop,
        |audio_path, offsets| {
            let samples = read_wav_16k_mono(audio_path)?;
            let groups = input
                .iter()
                .filter(|segment| !segment.words.is_empty())
                .map(|segment| {
                    segment
                        .words
                        .iter()
                        .map(|word| {
                            Some(CaptionWord {
                                text: word.text.clone(),
                                start: to_concatenated_time(word.start, offsets)?,
                                end: to_concatenated_time(word.end, offsets)?,
                            })
                        })
                        .collect::<Option<Vec<_>>>()
                })
                .collect::<Option<Vec<_>>>()
                .ok_or("The captions no longer match the transcribed audio")?;
            let recover = |words: &mut Vec<CaptionWord>| {
                #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
                if is_parakeet_model(model) {
                    super::invalidate_parakeet_cache_for_dir(&model_file);
                    match super::load_parakeet(
                        &model_file.to_string_lossy(),
                        Some(REFINEMENT_THREADS),
                    ) {
                        Ok(mut parakeet) => super::recover_unheard_speech(
                            &samples,
                            words,
                            &mut parakeet,
                            options.parakeet_subword_words,
                            stop,
                        ),
                        Err(error) => tracing::warn!("Skipping speech recovery: {error}"),
                    }
                }
                #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
                let _ = (words, is_parakeet_model(model));
            };
            let aligner = || {
                invalidate_whisper_cache_for_path(&model_file);
                load_word_aligner(runtime.as_ref())
            };
            let pass = Pass {
                samples: &samples,
                language: &request.language,
                options: &options,
                tuning: &TUNING,
                stop,
            };
            Ok(
                refine_groups(&pass, groups, recover, aligner).map(|groups| {
                    keep_caption_identities(
                        input,
                        groups,
                        &request.language,
                        request.segment_words,
                        offsets,
                    )
                }),
            )
        },
    )?;
    Ok(segments
        .filter(|segments| !segments.is_empty())
        .map(|segments| RefinedCaptions::new(input, segments)))
}

/// Re-chunks each input caption's refined words on its own. The first chunk
/// keeps the caption's id and any later one gets the first free `<id>-<n>`,
/// so per-caption overrides, which follow ids, stay on the caption they were
/// set on and a refinement run again over split captions mints no duplicate.
fn keep_caption_identities(
    input: &[CaptionSegment],
    groups: Vec<Vec<CaptionWord>>,
    language: &str,
    segment_words: usize,
    offsets: &[TranscriptionAudioOffset],
) -> Vec<CaptionSegment> {
    let mut used: std::collections::HashSet<String> =
        input.iter().map(|segment| segment.id.clone()).collect();
    let mut groups = groups.into_iter();
    let mut refined = Vec::with_capacity(input.len());
    for segment in input {
        if segment.words.is_empty() {
            refined.push(segment.clone());
            continue;
        }
        let Some(group) = groups.next() else {
            break;
        };
        for (chunk, part) in caption_segments_from_groups(vec![group], language, segment_words)
            .into_iter()
            .enumerate()
        {
            if let Some(mut restored) = restore_source_timestamps(vec![part], offsets).pop() {
                restored.id = if chunk == 0 {
                    segment.id.clone()
                } else {
                    let id = (chunk..)
                        .map(|suffix| format!("{}-{suffix}", segment.id))
                        .find(|id| !used.contains(id))
                        .unwrap_or_default();
                    used.insert(id.clone());
                    id
                };
                refined.push(restored);
            }
        }
    }
    refined
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start: f32, end: f32) -> CaptionWord {
        CaptionWord {
            text: text.to_string(),
            start,
            end,
        }
    }

    #[test]
    fn request_ranges_are_clamped_and_merged() {
        let request = RefinementRequest {
            model: "best".to_string(),
            language: "en".to_string(),
            ranges: vec![
                [5.0, 8.0],
                [0.0, 6.0],
                [0.0, 6.0],
                [f64::NAN, 3.0],
                [-4.0, 1.0],
                [9.0, 400.0],
                [500.0, 600.0],
            ],
            segment_words: cap_project::TARGET_CAPTION_WORDS_PER_SEGMENT,
        };
        assert_eq!(
            sanitized_ranges(&request, &[10.0]).unwrap(),
            vec![0.0..8.0, 9.0..10.0]
        );
        let outside = RefinementRequest {
            ranges: vec![[20.0, 30.0]],
            ..request
        };
        assert!(sanitized_ranges(&outside, &[10.0]).is_err());
    }

    #[test]
    fn captions_keep_their_ids_when_recovered_words_split_them() {
        let caption = |id: &str, words: Vec<CaptionWord>| CaptionSegment {
            id: id.to_string(),
            start: words[0].start,
            end: words[words.len() - 1].end,
            text: String::new(),
            words,
        };
        let input = vec![
            caption("segment-0", vec![word("so", 0.0, 0.2)]),
            caption("segment-1", vec![word("done", 9.0, 9.4)]),
        ];
        let grown: Vec<CaptionWord> = (0..14)
            .map(|index| word("word", index as f32 * 0.4, index as f32 * 0.4 + 0.3))
            .collect();
        let offsets = [TranscriptionAudioOffset {
            concatenated_start: 0.0,
            source_start: 0.0,
            length: 60.0,
        }];
        let refined = keep_caption_identities(
            &input,
            vec![grown, vec![word("done", 9.0, 9.4)]],
            "en",
            cap_project::TARGET_CAPTION_WORDS_PER_SEGMENT,
            &offsets,
        );
        let ids: Vec<&str> = refined.iter().map(|segment| segment.id.as_str()).collect();
        assert!(ids.len() > 2, "{ids:?}");
        assert_eq!(ids[0], "segment-0");
        assert_eq!(ids[1], "segment-0-1");
        assert_eq!(*ids.last().unwrap(), "segment-1");
    }

    #[test]
    fn refining_split_captions_again_mints_no_duplicate_ids() {
        let caption = |id: &str, words: Vec<CaptionWord>| CaptionSegment {
            id: id.to_string(),
            start: words[0].start,
            end: words[words.len() - 1].end,
            text: String::new(),
            words,
        };
        let input = vec![
            caption("segment-0", vec![word("so", 0.0, 0.2)]),
            caption("segment-0-1", vec![word("then", 6.0, 6.2)]),
        ];
        let grown: Vec<CaptionWord> = (0..14)
            .map(|index| word("word", index as f32 * 0.4, index as f32 * 0.4 + 0.3))
            .collect();
        let offsets = [TranscriptionAudioOffset {
            concatenated_start: 0.0,
            source_start: 0.0,
            length: 60.0,
        }];
        let refined = keep_caption_identities(
            &input,
            vec![grown, vec![word("then", 6.0, 6.2)]],
            "en",
            cap_project::TARGET_CAPTION_WORDS_PER_SEGMENT,
            &offsets,
        );
        let mut ids: Vec<&str> = refined.iter().map(|segment| segment.id.as_str()).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "{ids:?}");
    }

    #[test]
    fn recovered_words_join_the_group_before_them() {
        let groups = vec![
            vec![word("so", 0.0, 0.2), word("I", 0.3, 0.4)],
            vec![word("think", 2.0, 2.4)],
        ];
        let words = vec![
            word("so", 0.0, 0.2),
            word("um", 0.2, 0.3),
            word("I", 0.3, 0.4),
            word("uh", 1.0, 1.3),
            word("think", 2.0, 2.4),
        ];
        let regrouped = regroup(&groups, words);
        let texts: Vec<Vec<&str>> = regrouped
            .iter()
            .map(|group| group.iter().map(|word| word.text.as_str()).collect())
            .collect();
        assert_eq!(texts, vec![vec!["so", "um", "I", "uh"], vec!["think"]]);
    }

    #[test]
    fn retimes_follow_input_words_past_recovered_ones() {
        let segment = |words: Vec<CaptionWord>| CaptionSegment {
            id: "segment-0".to_string(),
            start: words.first().map_or(0.0, |word| word.start),
            end: words.last().map_or(0.0, |word| word.end),
            text: String::new(),
            words,
        };
        let input = vec![segment(vec![word("the", 1.0, 1.4), word("the", 1.4, 1.9)])];
        let refined = vec![segment(vec![
            word("uh", 0.5, 0.8),
            word("the", 1.02, 1.2),
            word("the", 1.45, 1.6),
        ])];
        let retimed = match_retimes(&input, &refined);
        assert_eq!(retimed[&word_key(&input[0].words[0])], (1.02, 1.2));
        assert_eq!(retimed[&word_key(&input[0].words[1])], (1.45, 1.6));
    }
}
