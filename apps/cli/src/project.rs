use std::path::{Path, PathBuf};

use cap_project::{
    InstantRecordingMeta, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    StudioRecordingStatus,
};
use serde::Serialize;

use crate::{OutputFormat, write_json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInspection {
    pub project_path: PathBuf,
    pub output_path: PathBuf,
    /// camelCase convenience fields so agents never reach into the snake_case `meta` passthrough.
    pub name: String,
    pub recording_type: &'static str,
    pub meta: RecordingMeta,
    pub config: cap_project::ProjectConfiguration,
}

pub fn config_get(project_path: PathBuf) -> Result<(), String> {
    let config = match cap_project::ProjectConfiguration::load(&project_path) {
        Ok(config) => config,
        // Instant and un-edited studio recordings have no project-config.json; return the
        // effective default the editor/exporter would use rather than erroring.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::from_str("{}")
            .map_err(|e| format!("Failed to build default project config: {e}"))?,
        Err(e) => return Err(format!("Failed to load project config: {e}")),
    };
    crate::write_json(&config)
}

pub fn config_set(
    project_path: PathBuf,
    settings_json: &str,
    format: OutputFormat,
) -> Result<(), String> {
    let config: cap_project::ProjectConfiguration = serde_json::from_str(settings_json)
        .map_err(|e| format!("Invalid project config JSON: {e}"))?;
    // write() validates internally before its atomic temp-file-then-rename.
    config
        .write(&project_path)
        .map_err(|e| format!("Failed to write project config: {e}"))?;
    if let OutputFormat::Json = format {
        crate::write_json(&serde_json::json!({ "ok": true }))?;
    }
    Ok(())
}

pub fn inspect(project_path: PathBuf, format: OutputFormat) -> Result<(), String> {
    let meta = RecordingMeta::load_for_project(&project_path)
        .map_err(|e| format!("Failed to load recording meta: {e}"))?;
    let output_path = meta.output_path();
    let config = meta.project_config();

    match format {
        OutputFormat::Text => {
            println!("project: {}", project_path.display());
            println!("name: {}", meta.pretty_name);
            println!("type: {}", recording_type(&meta));
            println!("output: {}", output_path.display());
            Ok(())
        }
        OutputFormat::Json => write_json(&ProjectInspection {
            project_path,
            output_path,
            name: meta.pretty_name.clone(),
            recording_type: recording_type(&meta),
            meta,
            config,
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCheck {
    role: &'static str,
    path: PathBuf,
    exists: bool,
    required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationReport {
    project_path: PathBuf,
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    recording_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    checks: Vec<FileCheck>,
    missing: Vec<PathBuf>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    problems: Vec<String>,
}

fn recording_type(meta: &RecordingMeta) -> &'static str {
    match meta.inner {
        RecordingMetaInner::Studio(_) => "studio",
        RecordingMetaInner::Instant(_) => "instant",
    }
}

fn required_check(role: &'static str, path: PathBuf) -> FileCheck {
    FileCheck {
        exists: path.exists(),
        role,
        path,
        required: true,
    }
}

fn optional_check(role: &'static str, path: PathBuf) -> FileCheck {
    FileCheck {
        exists: path.exists(),
        role,
        path,
        required: false,
    }
}

fn studio_checks(meta: &RecordingMeta, studio: &StudioRecordingMeta) -> Vec<FileCheck> {
    let mut checks = Vec::new();

    match studio {
        StudioRecordingMeta::SingleSegment { segment } => {
            checks.push(required_check(
                "displayVideo",
                meta.path(&segment.display.path),
            ));
            if let Some(camera) = &segment.camera {
                checks.push(required_check("camera", meta.path(&camera.path)));
            }
            if let Some(audio) = &segment.audio {
                checks.push(required_check("audio", meta.path(&audio.path)));
            }
            if let Some(cursor) = &segment.cursor {
                checks.push(optional_check("cursor", meta.path(cursor)));
            }
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            for segment in &inner.segments {
                checks.push(required_check(
                    "displayVideo",
                    meta.path(&segment.display.path),
                ));
                if let Some(camera) = &segment.camera {
                    checks.push(required_check("camera", meta.path(&camera.path)));
                }
                if let Some(mic) = &segment.mic {
                    checks.push(required_check("mic", meta.path(&mic.path)));
                }
                if let Some(system_audio) = &segment.system_audio {
                    checks.push(required_check("systemAudio", meta.path(&system_audio.path)));
                }
                if let Some(cursor) = &segment.cursor {
                    checks.push(optional_check("cursor", meta.path(cursor)));
                }
            }
        }
    }

    checks
}

fn studio_problems(studio: &StudioRecordingMeta) -> Vec<String> {
    let mut problems = Vec::new();

    if let StudioRecordingMeta::MultipleSegments { inner } = studio {
        if inner.segments.is_empty() {
            problems.push("studio recording has no segments".to_string());
        }
    }

    match studio.status() {
        StudioRecordingStatus::Complete => {}
        StudioRecordingStatus::InProgress => {
            problems.push("studio recording is still in progress".to_string());
        }
        StudioRecordingStatus::NeedsRemux => {
            problems.push("studio recording still needs remux".to_string());
        }
        StudioRecordingStatus::Failed { error } => {
            problems.push(format!("studio recording failed: {error}"));
        }
    }

    problems
}

fn instant_problems(instant: &InstantRecordingMeta) -> Vec<String> {
    match instant {
        InstantRecordingMeta::Complete { .. } => Vec::new(),
        InstantRecordingMeta::InProgress { recording } => {
            let state = if *recording {
                "still recording"
            } else {
                "incomplete"
            };
            vec![format!("instant recording is {state}")]
        }
        InstantRecordingMeta::Failed { error } => {
            vec![format!("instant recording failed: {error}")]
        }
    }
}

fn build_report(project_path: &Path, meta: &RecordingMeta) -> ValidationReport {
    let mut checks = vec![required_check(
        "recordingMeta",
        project_path.join("recording-meta.json"),
    )];
    checks.push(optional_check(
        "projectConfig",
        project_path.join("project-config.json"),
    ));

    let problems = match &meta.inner {
        RecordingMetaInner::Studio(studio) => {
            checks.extend(studio_checks(meta, studio));
            checks.push(optional_check("output", meta.output_path()));
            studio_problems(studio)
        }
        RecordingMetaInner::Instant(instant) => {
            checks.push(required_check("output", meta.output_path()));
            instant_problems(instant)
        }
    };

    let missing: Vec<PathBuf> = checks
        .iter()
        .filter(|c| c.required && !c.exists)
        .map(|c| c.path.clone())
        .collect();

    let valid = missing.is_empty() && problems.is_empty();
    let error = (!valid).then(|| {
        let mut reasons = Vec::new();
        if !missing.is_empty() {
            reasons.push(format!("missing {} required file(s)", missing.len()));
        }
        reasons.extend(problems.iter().cloned());
        format!("project validation failed: {}", reasons.join("; "))
    });

    ValidationReport {
        project_path: project_path.to_path_buf(),
        valid,
        recording_type: Some(recording_type(meta)),
        error,
        checks,
        missing,
        problems,
    }
}

pub(crate) fn validate_project(project_path: &Path) -> Result<(), String> {
    let meta = RecordingMeta::load_for_project(project_path)
        .map_err(|e| format!("Failed to load recording meta: {e}"))?;
    let report = build_report(project_path, &meta);

    if report.valid {
        Ok(())
    } else {
        Err(report
            .error
            .unwrap_or_else(|| "project validation failed".to_string()))
    }
}

pub fn validate(project_path: PathBuf, format: OutputFormat) -> Result<(), String> {
    let report = match RecordingMeta::load_for_project(&project_path) {
        Ok(meta) => build_report(&project_path, &meta),
        Err(e) => ValidationReport {
            checks: vec![required_check(
                "recordingMeta",
                project_path.join("recording-meta.json"),
            )],
            missing: vec![project_path.join("recording-meta.json")],
            project_path: project_path.clone(),
            valid: false,
            recording_type: None,
            error: Some(format!("Failed to load recording meta: {e}")),
            problems: Vec::new(),
        },
    };

    let valid = report.valid;

    match format {
        OutputFormat::Json => write_json(&report)?,
        OutputFormat::Text => {
            println!("project: {}", report.project_path.display());
            if let Some(error) = &report.error {
                println!("error: {error}");
            }
            for problem in &report.problems {
                println!("problem: {problem}");
            }
            for check in &report.checks {
                let status = if check.exists { "ok" } else { "missing" };
                let required = if check.required {
                    "required"
                } else {
                    "optional"
                };
                println!(
                    "  [{status}] {} ({required}): {}",
                    check.role,
                    check.path.display()
                );
            }
            println!("valid: {valid}");
        }
    }

    if valid {
        Ok(())
    } else {
        Err("project validation failed".to_string())
    }
}
