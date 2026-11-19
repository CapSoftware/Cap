use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use cap_editor::EditorInstance;
use cap_export::preview::{ExportPreviewSettings, render_frame_with_editor};
use cap_project::{ProjectConfiguration, XY};
use cap_sensitive_scan::{
    LumaFrame, MODELS, ModelFile, ScanSettings, Scanner, SensitiveTrack, TextReader, in_motion,
    mask_segments,
};
use futures_util::StreamExt as _;
use gpui::{
    AnyElement, Context, Hsla, InteractiveElement, IntoElement, ParentElement, SharedString,
    Styled, Task, Window, div, prelude::FluentBuilder, px,
};

use crate::{
    editor_edits::{self as edits, Selection},
    editor_panels::FieldKey,
    editor_timeline::TrackKind,
    editor_window::EditorWindow,
    i18n::tr,
    ui,
};

const SCAN_RESOLUTION: XY<u32> = XY { x: 1920, y: 1080 };
const MODEL_DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum ScanStage {
    Downloading(f32),
    Scanning(f32),
}

pub(crate) struct SensitiveScanJob {
    pub(crate) stage: ScanStage,
    cancel: Arc<AtomicBool>,
    _task: Task<()>,
}

impl Drop for SensitiveScanJob {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

enum ScanEvent {
    Stage(ScanStage),
    Done(Result<Option<Vec<SensitiveTrack>>, String>),
}

fn models_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("so.cap.desktop")
        .join("sensitive-scan")
}

fn model_installed(dir: &Path, model: &ModelFile) -> bool {
    std::fs::metadata(dir.join(model.file_name)).is_ok_and(|metadata| metadata.len() == model.size)
}

async fn download_model(
    dir: &Path,
    model: &ModelFile,
    progress: impl Fn(f32),
) -> Result<(), String> {
    use sha2::Digest as _;
    use std::io::Write as _;
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {dir:?}: {e}"))?;
    let path = dir.join(model.file_name);
    let staging = path.with_extension("onnx.downloading");
    let result = async {
        let response = reqwest::Client::new()
            .get(model.url)
            .timeout(MODEL_DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("Failed to download {}: {e}", model.file_name))?;
        if !response.status().is_success() {
            return Err(format!(
                "Failed to download {}: HTTP {}",
                model.file_name,
                response.status()
            ));
        }
        let mut file = std::fs::File::create(&staging)
            .map_err(|e| format!("Failed to create {staging:?}: {e}"))?;
        let mut hasher = sha2::Sha256::new();
        let mut received = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Error while downloading: {e}"))?;
            hasher.update(&chunk);
            file.write_all(&chunk)
                .map_err(|e| format!("Error while writing {}: {e}", model.file_name))?;
            received += chunk.len() as u64;
            progress((received as f32 / model.size as f32).min(1.0));
        }
        file.flush()
            .map_err(|e| format!("Failed to flush {}: {e}", model.file_name))?;
        let hex: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if hex != model.sha256 {
            return Err(format!("{} is corrupt (sha256 {hex})", model.file_name));
        }
        std::fs::rename(&staging, &path)
            .map_err(|e| format!("Failed to install {}: {e}", model.file_name))
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

async fn scan(
    instance: Arc<EditorInstance>,
    project: ProjectConfiguration,
    phrases: Vec<String>,
    cancel: Arc<AtomicBool>,
    events: flume::Sender<ScanEvent>,
) -> Result<Option<Vec<SensitiveTrack>>, String> {
    let dir = models_dir();
    let total: u64 = MODELS.iter().map(|model| model.size).sum();
    let mut done = 0u64;
    for model in &MODELS {
        if !model_installed(&dir, model) {
            let base = done;
            download_model(&dir, model, |fraction| {
                let received = base as f32 + fraction * model.size as f32;
                let _ = events.send(ScanEvent::Stage(ScanStage::Downloading(
                    received / total as f32,
                )));
            })
            .await?;
        }
        done += model.size;
        if cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
    }

    let reader = tokio::task::spawn_blocking(move || {
        cap_camera_effects::initialize_onnx_runtime()?;
        TextReader::load(&dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))?;

    let settings = ScanSettings {
        phrases,
        ..Default::default()
    };
    let render = ExportPreviewSettings {
        fps: settings.sample_fps.round() as u32,
        resolution_base: SCAN_RESOLUTION,
        compression_bpp: 0.1,
        cursor_only: false,
        gif_quality: None,
    };
    let (first, duration) = render_frame_with_editor(&instance, project.clone(), 0.0, render)
        .await
        .map_err(|e| e.to_string())?;
    let times = settings.sample_times(duration);
    let count = times.len().max(1);

    let (frames, received) = flume::bounded::<(f64, LumaFrame)>(2);
    let worker = std::thread::Builder::new()
        .name("cap-sensitive-scan".into())
        .spawn(move || -> anyhow::Result<Vec<SensitiveTrack>> {
            let mut scanner = Scanner::new(&reader, settings);
            for (time, frame) in received {
                scanner.push_frame(time, &frame)?;
            }
            scanner.finish()
        })
        .map_err(|e| e.to_string())?;

    let mut first = Some(luma(&first));
    let mut previous: Option<(f64, LumaFrame)> = None;
    for (index, time) in times.into_iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        let frame = match first.take() {
            Some(frame) => frame,
            None => render_luma(&instance, &project, time, render).await?,
        };
        if let Some((before, earlier)) = &previous
            && in_motion(earlier, &frame)
        {
            let middle = (before + time) / 2.0;
            let between = render_luma(&instance, &project, middle, render).await?;
            if frames.send_async((middle, between)).await.is_err() {
                break;
            }
        }
        if frames.send_async((time, frame.clone())).await.is_err() {
            break;
        }
        previous = Some((time, frame));
        let _ = events.send(ScanEvent::Stage(ScanStage::Scanning(
            index as f32 / count as f32,
        )));
    }
    drop(frames);
    let tracks = tokio::task::spawn_blocking(move || worker.join())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "The scan stopped unexpectedly".to_string())?
        .map_err(|e| format!("{e:#}"))?;
    if cancel.load(Ordering::Acquire) {
        return Ok(None);
    }
    Ok(Some(tracks))
}

fn luma(frame: &cap_rendering::RenderedFrame) -> LumaFrame {
    LumaFrame::from_rgba(
        frame.width,
        frame.height,
        frame.padded_bytes_per_row as usize,
        &frame.data,
    )
}

async fn render_luma(
    instance: &EditorInstance,
    project: &ProjectConfiguration,
    time: f64,
    render: ExportPreviewSettings,
) -> Result<LumaFrame, String> {
    let (frame, _) = render_frame_with_editor(instance, project.clone(), time, render)
        .await
        .map_err(|e| e.to_string())?;
    Ok(luma(&frame))
}

fn scan_input(project: &ProjectConfiguration) -> ProjectConfiguration {
    let mut project = project.clone();
    project.sensitive_phrases.clear();
    project.captions = None;
    project.keyboard = None;
    project.annotations.clear();
    if let Some(timeline) = project.timeline.as_mut() {
        timeline.mask_segments.clear();
        timeline.text_segments.clear();
        timeline.caption_segments.clear();
        timeline.keyboard_segments.clear();
        timeline.image_segments.clear();
        timeline.shape_segments.clear();
    }
    project
}

fn add_phrase(phrases: &mut Vec<String>, phrase: &str) -> bool {
    let phrase = phrase.trim();
    if phrase.is_empty()
        || phrases
            .iter()
            .any(|known| known.eq_ignore_ascii_case(phrase))
    {
        return false;
    }
    phrases.push(phrase.to_string());
    true
}

impl EditorWindow {
    pub(crate) fn start_sensitive_scan(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sensitive_scan.is_some() {
            return;
        }
        let Some(instance) = self.instance.clone() else {
            return;
        };
        let project = scan_input(&self.project);
        let Ok(snapshot) = serde_json::to_value(&project) else {
            return;
        };
        let phrases = self.project.sensitive_phrases.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let (events, received) = flume::unbounded();
        let job_cancel = cancel.clone();
        let worker = gpui_tokio::Tokio::spawn(cx, async move {
            let result = scan(instance, project, phrases, job_cancel, events.clone()).await;
            let _ = events.send(ScanEvent::Done(result));
        });
        let task = cx.spawn_in(window, async move |this, cx| {
            let _worker = worker;
            while let Ok(event) = received.recv_async().await {
                let done = matches!(event, ScanEvent::Done(_));
                let _ = this.update_in(cx, |this, window, cx| {
                    match event {
                        ScanEvent::Stage(stage) => {
                            if let Some(job) = this.sensitive_scan.as_mut() {
                                job.stage = stage;
                            }
                        }
                        ScanEvent::Done(result) => {
                            this.sensitive_scan = None;
                            this.finish_sensitive_scan(result, &snapshot, window, cx);
                        }
                    }
                    cx.notify();
                });
                if done {
                    break;
                }
            }
        });
        let models = models_dir();
        let stage = if MODELS.iter().all(|model| model_installed(&models, model)) {
            ScanStage::Scanning(0.0)
        } else {
            ScanStage::Downloading(0.0)
        };
        self.sensitive_scan = Some(SensitiveScanJob {
            stage,
            cancel,
            _task: task,
        });
        cx.notify();
    }

    pub(crate) fn stop_sensitive_scan(&mut self, cx: &mut Context<Self>) {
        self.sensitive_scan = None;
        cx.notify();
    }

    fn finish_sensitive_scan(
        &mut self,
        result: Result<Option<Vec<SensitiveTrack>>, String>,
        snapshot: &serde_json::Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let tracks = match result {
            Ok(Some(tracks)) => tracks,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, "sensitive data scan failed");
                self.show_notice(tr::editor::panel::mask::scan_failed(), window, cx);
                return;
            }
        };
        if serde_json::to_value(scan_input(&self.project))
            .ok()
            .as_ref()
            != Some(snapshot)
        {
            self.show_notice(tr::editor::panel::mask::scan_changed(), window, cx);
            return;
        }
        let existing = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| timeline.mask_segments.clone())
            .unwrap_or_default();
        let segments = mask_segments(&tracks, &existing, self.total_duration());
        tracing::info!(
            tracks = tracks.len(),
            masks = segments.len(),
            "sensitive data scan finished"
        );
        if segments.is_empty() {
            self.show_notice(tr::editor::panel::mask::scan_none(), window, cx);
            return;
        }
        let count = segments.len();
        let lanes = segments
            .iter()
            .map(|segment| segment.track + 1)
            .max()
            .unwrap_or(0);
        let added: Vec<(f64, u32)> = segments
            .iter()
            .map(|segment| (segment.start, segment.track))
            .collect();
        let height = self.preferred_timeline_height();
        let inserted = self.edit_timeline_project(
            move |project| {
                let Some(timeline) = project.timeline.as_mut() else {
                    return false;
                };
                for segment in segments {
                    edits::insert_mask_segment(timeline, segment);
                }
                true
            },
            window,
            cx,
        );
        if !inserted {
            return;
        }
        self.timeline_height_override.get_or_insert(height);
        self.tracks.mask = self.tracks.mask.max(lanes);
        let indices: Vec<usize> = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| {
                timeline
                    .mask_segments
                    .iter()
                    .enumerate()
                    .filter(|(_, segment)| added.contains(&(segment.start, segment.track)))
                    .map(|(index, _)| index)
                    .collect()
            })
            .unwrap_or_default();
        self.set_selection(
            Some(Selection {
                track: TrackKind::Mask,
                indices,
            }),
            cx,
        );
        self.note_edit("sensitive-scan", Some(TrackKind::Mask));
        self.show_notice(tr::editor::panel::mask::scan_found(count), window, cx);
    }

    pub(crate) fn add_sensitive_phrase(
        &mut self,
        phrase: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let phrase = phrase.to_string();
        self.edit_project_without_timeline("sensitive-phrase", window, cx, move |project| {
            add_phrase(&mut project.sensitive_phrases, &phrase)
        });
    }

    fn remove_sensitive_phrase(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_project_without_timeline("sensitive-phrase", window, cx, move |project| {
            if index >= project.sensitive_phrases.len() {
                return false;
            }
            project.sensitive_phrases.remove(index);
            true
        });
    }

    pub(crate) fn render_sensitive_scan(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let muted = Hsla::from(theme.gray_11);
        let stage = self.sensitive_scan.as_ref().map(|job| job.stage);
        let phrases = div().flex().flex_wrap().gap(px(6.)).children(
            self.project
                .sensitive_phrases
                .iter()
                .enumerate()
                .map(|(index, phrase)| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .pl(px(8.))
                        .pr(px(2.))
                        .h(px(24.))
                        .rounded(px(6.))
                        .bg(Hsla::from(theme.editor.ctl))
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.editor.text_1))
                        .child(SharedString::from(phrase.clone()))
                        .child(
                            ui::IconButton::new(
                                SharedString::from(format!("sensitive-phrase-remove-{index}")),
                                "icons/x.svg",
                            )
                            .size(px(18.))
                            .icon_size(px(10.))
                            .disabled(stage.is_some())
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.remove_sensitive_phrase(index, window, cx)
                                },
                            )),
                        )
                }),
        );
        let input = self
            .field(FieldKey::SensitivePhrase)
            .map(|input| ui::TextInput::plain(&theme, "sensitive-phrase-input", input));
        let action = match stage {
            Some(stage) => {
                let (label, fraction) = match stage {
                    ScanStage::Downloading(fraction) => (
                        tr::editor::panel::mask::scan_downloading((fraction * 100.).round() as u32),
                        fraction,
                    ),
                    ScanStage::Scanning(fraction) => (
                        tr::editor::panel::mask::scan_progress((fraction * 100.).round() as u32),
                        fraction,
                    ),
                };
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(div().text_size(px(12.)).text_color(muted).child(label))
                            .child(
                                div()
                                    .h(px(4.))
                                    .rounded_full()
                                    .bg(Hsla::from(theme.gray_4))
                                    .child(
                                        div()
                                            .h_full()
                                            .w(gpui::relative(fraction.clamp(0., 1.)))
                                            .rounded_full()
                                            .bg(Hsla::from(theme.blue_9)),
                                    ),
                            ),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "sensitive-scan-stop",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Sm,
                        )
                        .radius(px(8.))
                        .label(tr::common::cancel())
                        .on_click(cx.listener(|this, _, _, cx| this.stop_sensitive_scan(cx))),
                    )
                    .into_any_element()
            }
            None => ui::Button::plain(
                &theme,
                "sensitive-scan-start",
                ui::ButtonVariant::Primary,
                ui::ButtonSize::Sm,
            )
            .full_width()
            .radius(px(8.))
            .icon("icons/scan-text.svg")
            .label(tr::editor::panel::mask::scan_start())
            .disabled(self.instance.is_none())
            .on_click(cx.listener(|this, _, window, cx| this.start_sensitive_scan(window, cx)))
            .into_any_element(),
        };
        div()
            .id("sensitive-scan")
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(Hsla::from(theme.editor.text_1))
                            .child(tr::editor::panel::mask::scan_title()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(muted)
                            .child(tr::editor::panel::mask::scan_description()),
                    ),
            )
            .child(
                ui::Field::section(&theme, tr::editor::panel::mask::scan_phrases()).child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .children(input)
                        .when(!self.project.sensitive_phrases.is_empty(), |column| {
                            column.child(phrases)
                        }),
                ),
            )
            .child(action)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrases_are_trimmed_and_kept_once_ignoring_case() {
        let mut phrases = Vec::new();
        assert!(add_phrase(&mut phrases, " Acme Robotics "));
        assert!(!add_phrase(&mut phrases, "acme robotics"));
        assert!(!add_phrase(&mut phrases, "   "));
        assert!(add_phrase(&mut phrases, "Project Falcon"));
        assert_eq!(phrases, ["Acme Robotics", "Project Falcon"]);
    }

    #[test]
    fn the_scan_reads_the_screen_without_layers_drawn_above_masks() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [],
                "zoomSegments": [],
                "textSegments": [{ "start": 0.0, "end": 1.0, "content": "jane@acme.io" }],
                "keyboardSegments": [{ "id": "keys", "start": 0.0, "end": 1.0, "displayText": "Cmd K" }],
                "captionSegments": [{ "id": "caption", "start": 0.0, "end": 1.0, "text": "jane@acme.io" }],
            },
        }))
        .unwrap();
        project.sensitive_phrases = vec!["Acme".into()];
        let input = scan_input(&project);
        let timeline = input.timeline.as_ref().unwrap();
        assert!(timeline.text_segments.is_empty());
        assert!(timeline.caption_segments.is_empty());
        assert!(timeline.keyboard_segments.is_empty());
        assert!(input.sensitive_phrases.is_empty());
        assert!(input.captions.is_none() && input.keyboard.is_none());
    }
}
