use serde::{Deserialize, Serialize};

use crate::{Action, Point, Step};

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentStep {
    pub step: Step,
    pub image: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Document {
    pub title: String,
    pub duration: f64,
    pub intro: String,
    pub steps: Vec<DocumentStep>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Captions {
    pub step: String,
    pub click: String,
    pub double_click: String,
    pub right_click: String,
    pub drag: String,
    pub repeat: String,
}

impl Default for Captions {
    fn default() -> Self {
        Self {
            step: "Step {number}".into(),
            click: "Click the highlighted spot.".into(),
            double_click: "Double-click the highlighted spot.".into(),
            right_click: "Right-click the highlighted spot.".into(),
            drag: "Drag along the arrow.".into(),
            repeat: "Click the highlighted spot {count} times.".into(),
        }
    }
}

const IMAGE_NAME_START: &str = "step-";
const IMAGE_NAME_END: &str = ".png";

pub fn image_name(index: usize, total: usize) -> String {
    let digits = total.max(index).to_string().len().max(2);
    format!("{IMAGE_NAME_START}{index:0digits$}{IMAGE_NAME_END}")
}

pub fn is_image_name(name: &str) -> bool {
    name.strip_prefix(IMAGE_NAME_START)
        .and_then(|rest| rest.strip_suffix(IMAGE_NAME_END))
        .is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        })
}

pub fn timestamp(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0.0 {
        seconds as u64
    } else {
        0
    };
    let (hours, minutes, seconds) = (total / 3600, total / 60 % 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// Narration is speech, not Markdown: anything in it that Markdown would
/// read as formatting is kept as the character it is.
fn escape(text: &str) -> String {
    let numbered = text
        .find(|character: char| !character.is_ascii_digit())
        .filter(|end| *end > 0 && text[*end..].starts_with(['.', ')']));
    let mut escaped = String::with_capacity(text.len());
    for (index, character) in text.char_indices() {
        let special = matches!(
            character,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '&' | '~'
        ) || (index == 0 && matches!(character, '#' | '-' | '+'))
            || numbered == Some(index);
        if special {
            escaped.push('\\');
        }
        escaped.push(if character.is_control() {
            ' '
        } else {
            character
        });
    }
    escaped
}

fn action_caption(step: &Step, captions: &Captions) -> Option<String> {
    match step.action {
        Action::Click if step.repeat > 1 => {
            Some(captions.repeat.replace("{count}", &step.repeat.to_string()))
        }
        Action::Click => Some(captions.click.clone()),
        Action::DoubleClick => Some(captions.double_click.clone()),
        Action::RightClick => Some(captions.right_click.clone()),
        Action::Drag => Some(captions.drag.clone()),
        Action::Note => None,
    }
}

pub fn instruction(step: &Step, captions: &Captions) -> String {
    let narration = step.narration.trim();
    if narration.is_empty() {
        action_caption(step, captions).unwrap_or_default()
    } else {
        narration.to_string()
    }
}

pub fn markdown(document: &Document, captions: &Captions) -> String {
    let mut blocks = vec![format!("# {}", escape(document.title.trim()))];
    let intro = document.intro.trim();
    if !intro.is_empty() {
        blocks.push(escape(intro));
    }
    for (index, entry) in document.steps.iter().enumerate() {
        let step = &entry.step;
        if let Some(heading) = step
            .heading
            .as_deref()
            .map(str::trim)
            .filter(|heading| !heading.is_empty())
        {
            blocks.push(format!("## {}", escape(heading)));
        }
        let label = captions.step.replace("{number}", &(index + 1).to_string());
        blocks.push(format!("### {label} · {}", timestamp(step.time)));
        let narration = step.narration.trim();
        let action = action_caption(step, captions);
        if narration.is_empty() {
            blocks.extend(action);
        } else {
            blocks.push(escape(narration));
            if step.action != Action::Click || step.repeat > 1 {
                blocks.extend(action.map(|action| format!("_{action}_")));
            }
        }
        blocks.push(format!("![{label}]({})", entry.image));
    }
    let mut text = blocks.join("\n\n");
    text.push('\n');
    text
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuideData<'a> {
    title: &'a str,
    duration: f64,
    intro: &'a str,
    steps: Vec<StepData<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepData<'a> {
    index: usize,
    time: f64,
    action: Action,
    position: Option<Point>,
    drag_to: Option<Point>,
    repeat: u32,
    heading: Option<&'a str>,
    narration: &'a str,
    image: &'a str,
}

#[derive(Deserialize)]
struct ListedGuide {
    #[serde(default)]
    steps: Vec<ListedStep>,
}

#[derive(Deserialize)]
struct ListedStep {
    #[serde(default)]
    image: String,
}

/// The `image` of every step in a guide's JSON, exactly as written there:
/// the text may come from a file someone else has edited, so these are not
/// yet paths to trust.
pub fn listed_images(json: &str) -> Vec<String> {
    serde_json::from_str::<ListedGuide>(json)
        .map(|guide| guide.steps.into_iter().map(|step| step.image).collect())
        .unwrap_or_default()
}

pub fn json(document: &Document) -> String {
    let data = GuideData {
        title: &document.title,
        duration: document.duration,
        intro: &document.intro,
        steps: document
            .steps
            .iter()
            .enumerate()
            .map(|(index, entry)| StepData {
                index: index + 1,
                time: entry.step.time,
                action: entry.step.action,
                position: entry.step.position,
                drag_to: entry.step.drag_to,
                repeat: entry.step.repeat,
                heading: entry.step.heading.as_deref(),
                narration: &entry.step.narration,
                image: &entry.image,
            })
            .collect(),
    };
    let mut text = serde_json::to_string_pretty(&data).unwrap_or_default();
    text.push('\n');
    text
}
