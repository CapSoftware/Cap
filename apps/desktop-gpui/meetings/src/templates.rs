use std::io;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::library::{DocKind, atomic_write};
use crate::transcript::PromptTranscript;

#[cfg(test)]
mod tests;

pub const DEFAULT_TEMPLATE_ID: &str = "general";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Section {
    pub heading: String,
    pub instruction: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub sections: Vec<Section>,
    pub built_in: bool,
    pub applies_to: Vec<DocKind>,
}

fn section(heading: &str, instruction: &str) -> Section {
    Section {
        heading: heading.to_string(),
        instruction: instruction.to_string(),
    }
}

fn built_in(id: &str, name: &str, description: &str, sections: Vec<Section>) -> Template {
    Template {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        sections,
        built_in: true,
        applies_to: vec![DocKind::Meeting],
    }
}

pub fn built_in_templates() -> Vec<Template> {
    vec![
        built_in(
            DEFAULT_TEMPLATE_ID,
            "General meeting",
            "A balanced summary that works for most conversations.",
            vec![
                section(
                    "Summary",
                    "Two or three sentences on why the meeting happened and where it landed.",
                ),
                section(
                    "Key points",
                    "The substantive points raised, grouped by topic, with who raised them when it matters.",
                ),
                section(
                    "Decisions",
                    "Every decision that was made, stated plainly, including what was explicitly ruled out.",
                ),
                section(
                    "Action items",
                    "Each follow-up as owner, task and due date when one was mentioned.",
                ),
                section(
                    "Open questions",
                    "Questions that were raised but not resolved, and who is expected to answer them.",
                ),
            ],
        ),
        built_in(
            "one-on-one",
            "One-on-one",
            "A private check-in between two people, focused on progress, blockers and growth.",
            vec![
                section(
                    "Check-in",
                    "How each person is doing and anything personal they chose to share about workload or wellbeing.",
                ),
                section(
                    "Progress",
                    "What moved forward since the last conversation, in the words of the person who did it.",
                ),
                section(
                    "Blockers and support",
                    "What is in the way and what help was offered or requested.",
                ),
                section(
                    "Feedback",
                    "Feedback given in either direction, kept specific and attributed.",
                ),
                section(
                    "Next steps",
                    "Commitments both people made before the next one-on-one.",
                ),
            ],
        ),
        built_in(
            "stand-up",
            "Stand-up",
            "A short team sync on yesterday, today and blockers.",
            vec![
                section(
                    "Updates by person",
                    "One short line per person covering what they finished and what they are doing next.",
                ),
                section(
                    "Blockers",
                    "Anything stopping work, who owns unblocking it and by when.",
                ),
                section(
                    "Follow-ups",
                    "Conversations that were taken offline and who needs to be in them.",
                ),
            ],
        ),
        built_in(
            "customer-call",
            "Customer call",
            "A conversation with an existing customer about their experience, needs and issues.",
            vec![
                section(
                    "Customer context",
                    "Who attended from the customer side, their role, and how they use the product today.",
                ),
                section(
                    "Feedback",
                    "What is working and what is not, quoting the customer where the wording matters.",
                ),
                section(
                    "Issues raised",
                    "Bugs, gaps or complaints, with severity and any workaround that was offered.",
                ),
                section(
                    "Requests",
                    "Features or changes the customer asked for and the problem behind each one.",
                ),
                section(
                    "Commitments",
                    "Everything promised to the customer, with an owner and a date.",
                ),
            ],
        ),
        built_in(
            "sales-discovery",
            "Sales discovery",
            "A first conversation with a prospect to understand fit, pain and buying process.",
            vec![
                section(
                    "Company and attendees",
                    "Who the prospect is, who was on the call and what each person cares about.",
                ),
                section(
                    "Current situation",
                    "How they solve the problem today and what tools or vendors are involved.",
                ),
                section(
                    "Pain points",
                    "The problems they described, their impact, and how urgent they seem.",
                ),
                section(
                    "Buying process",
                    "Budget, timeline, decision makers and any approval steps that were mentioned.",
                ),
                section(
                    "Objections and risks",
                    "Concerns raised and anything that could stall or block the deal.",
                ),
                section(
                    "Next steps",
                    "Agreed follow-ups, materials to send and the date of the next conversation.",
                ),
            ],
        ),
        built_in(
            "interview",
            "Interview",
            "A candidate interview, captured as evidence rather than impressions.",
            vec![
                section(
                    "Candidate background",
                    "Relevant experience and context the candidate shared about themselves.",
                ),
                section(
                    "Questions and answers",
                    "Each question asked and the substance of the answer, including concrete examples.",
                ),
                section(
                    "Strengths",
                    "Specific evidence of strengths, tied to something the candidate said or did.",
                ),
                section(
                    "Concerns",
                    "Specific gaps or risks, tied to evidence rather than general impressions.",
                ),
                section(
                    "Candidate questions",
                    "What the candidate asked and how it was answered.",
                ),
            ],
        ),
        built_in(
            "project-kickoff",
            "Project kickoff",
            "The first meeting of a project, setting goals, scope and ownership.",
            vec![
                section(
                    "Goals",
                    "What the project is meant to achieve and how success will be measured.",
                ),
                section(
                    "Scope",
                    "What is in, what is out, and anything that is still undecided.",
                ),
                section(
                    "Roles",
                    "Who owns what, who decides, and who needs to be kept informed.",
                ),
                section(
                    "Timeline",
                    "Milestones and dates that were agreed or proposed.",
                ),
                section(
                    "Risks and dependencies",
                    "Known risks, external dependencies and how they will be handled.",
                ),
                section(
                    "Next steps",
                    "Immediate tasks with owners to get the project moving.",
                ),
            ],
        ),
        built_in(
            "retrospective",
            "Retrospective",
            "A look back at a period of work to keep what worked and change what did not.",
            vec![
                section(
                    "What went well",
                    "Practices and outcomes the team wants to keep, with examples.",
                ),
                section(
                    "What did not go well",
                    "Problems the team ran into and their impact, without assigning blame.",
                ),
                section(
                    "Root causes",
                    "The underlying reasons the team identified for the main problems.",
                ),
                section(
                    "Changes to try",
                    "Concrete experiments the team agreed to run, each with an owner.",
                ),
            ],
        ),
        built_in(
            "brainstorm",
            "Brainstorm",
            "An open session for generating and narrowing down ideas.",
            vec![
                section(
                    "Problem",
                    "The question or challenge the session set out to explore.",
                ),
                section(
                    "Ideas",
                    "Every distinct idea raised, briefly described and credited to whoever proposed it.",
                ),
                section(
                    "Themes",
                    "Patterns or clusters that emerged across the ideas.",
                ),
                section(
                    "Shortlist",
                    "The ideas the group wanted to pursue and why they stood out.",
                ),
                section(
                    "Next steps",
                    "How the shortlisted ideas will be tested or developed, and by whom.",
                ),
            ],
        ),
        built_in(
            "board-update",
            "Board or investor update",
            "A meeting with the board or investors about performance, strategy and asks.",
            vec![
                section(
                    "Highlights",
                    "The most important progress since the last update, stated with numbers where given.",
                ),
                section(
                    "Metrics",
                    "Key figures discussed and how they compare with plan or the previous period.",
                ),
                section(
                    "Challenges",
                    "Problems or misses that were discussed and the plan to address them.",
                ),
                section(
                    "Strategic discussion",
                    "Larger questions about direction and the views each participant expressed.",
                ),
                section(
                    "Asks and decisions",
                    "Requests made of the board or investors, approvals given, and resolutions passed.",
                ),
                section(
                    "Follow-ups",
                    "Commitments made by management or the board, with owners.",
                ),
            ],
        ),
    ]
}

pub fn find_template<'a>(templates: &'a [Template], id: &str) -> Option<&'a Template> {
    templates.iter().find(|t| t.id == id)
}

pub fn all_templates(user: &[Template]) -> Vec<Template> {
    let mut all = built_in_templates();
    for template in user {
        if !template.id.is_empty() && !all.iter().any(|t| t.id == template.id) {
            let mut template = template.clone();
            template.built_in = false;
            all.push(template);
        }
    }
    all
}

pub fn templates_for(templates: &[Template], kind: &DocKind) -> Vec<Template> {
    templates
        .iter()
        .filter(|t| t.applies_to.is_empty() || t.applies_to.contains(kind))
        .cloned()
        .collect()
}

pub fn load_user_templates(path: &Path) -> io::Result<Vec<Template>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let value: Value = serde_json::from_slice(&bytes)?;
    let items = match value {
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("templates") {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    Ok(items
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Template>(v).ok())
        .filter(|t| !t.id.trim().is_empty())
        .map(|mut t| {
            t.built_in = false;
            t
        })
        .collect())
}

pub fn save_user_templates(path: &Path, templates: &[Template]) -> io::Result<()> {
    let built_in_ids: Vec<String> = built_in_templates().into_iter().map(|t| t.id).collect();
    let user: Vec<Template> = templates
        .iter()
        .filter(|t| !t.id.trim().is_empty() && !built_in_ids.contains(&t.id))
        .map(|t| Template {
            built_in: false,
            ..t.clone()
        })
        .collect();
    let bytes = serde_json::to_vec_pretty(&user)?;
    atomic_write(path, &bytes)
}

pub fn scaffold_markdown(template: &Template) -> String {
    template
        .sections
        .iter()
        .map(|s| s.heading.trim())
        .filter(|h| !h.is_empty())
        .map(|h| format!("## {h}\n\n"))
        .collect::<String>()
        .trim_end()
        .to_string()
}

pub fn suggested_heading_count(transcript_chars: usize) -> u32 {
    match transcript_chars {
        0..8_000 => 4,
        8_000..16_000 => 5,
        16_000..28_000 => 6,
        28_000..44_000 => 7,
        _ => 8,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TemplateSpec {
    pub id: String,
    pub name: String,
    pub sections: Vec<Section>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotesRequest {
    pub title: String,
    pub started_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<u64>,
    pub participants: Vec<String>,
    pub user_notes: String,
    pub transcript: String,
    pub transcript_truncated: bool,
    pub template: TemplateSpec,
    pub vocabulary: Vec<String>,
    pub summary_language: Option<String>,
    pub previous_summary: Option<String>,
    pub rewrite_instruction: Option<String>,
    pub heading_count: u32,
}

#[derive(Clone, Debug)]
pub struct NotesRequestBuilder {
    request: NotesRequest,
}

impl NotesRequest {
    pub fn builder(title: impl Into<String>, template: &Template) -> NotesRequestBuilder {
        NotesRequestBuilder {
            request: NotesRequest {
                title: title.into().trim().to_string(),
                template: TemplateSpec {
                    id: template.id.clone(),
                    name: template.name.clone(),
                    sections: template.sections.clone(),
                },
                heading_count: suggested_heading_count(0),
                ..NotesRequest::default()
            },
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

fn non_empty(s: impl Into<String>) -> Option<String> {
    let s: String = s.into();
    let trimmed = s.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

impl NotesRequestBuilder {
    pub fn when(mut self, started_at: DateTime<Utc>, duration_ms: Option<u64>) -> Self {
        self.request.started_at = Some(started_at);
        self.request.duration_ms = duration_ms;
        self
    }

    pub fn participants<I, S>(mut self, participants: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.request.participants = participants.into_iter().filter_map(non_empty).collect();
        self
    }

    pub fn user_notes(mut self, markdown: impl Into<String>) -> Self {
        self.request.user_notes = markdown.into();
        self
    }

    pub fn transcript(mut self, transcript: PromptTranscript) -> Self {
        self.request.heading_count = suggested_heading_count(transcript.text.chars().count());
        self.request.transcript = transcript.text;
        self.request.transcript_truncated = transcript.truncated;
        self
    }

    pub fn vocabulary(mut self, vocabulary: &[String]) -> Self {
        self.request.vocabulary = vocabulary.iter().cloned().filter_map(non_empty).collect();
        self
    }

    pub fn summary_language(mut self, language: Option<String>) -> Self {
        self.request.summary_language = language.and_then(non_empty);
        self
    }

    pub fn rewrite(
        mut self,
        previous_summary: impl Into<String>,
        instruction: impl Into<String>,
    ) -> Self {
        self.request.previous_summary = non_empty(previous_summary);
        self.request.rewrite_instruction = non_empty(instruction);
        self
    }

    pub fn build(self) -> NotesRequest {
        self.request
    }
}
