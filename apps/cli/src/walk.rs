//! `walk start|stop|status`: drive a walk or diatribe in the running desktop app for another
//! program (Z3's composer). The app records it exactly as from its own recorder and writes
//! each step to `<walk settings folder>/external-walks/<id>.json`
//! (`apps/desktop-gpui/src/ux_walk/external.rs`); this command sends the app's `start_walk`
//! / `stop_walk` deep links and reads that file back.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};

use crate::{OutputFormat, resolve_format, write_json, write_json_line};

#[derive(Args)]
pub struct WalkArgs {
    #[command(subcommand)]
    command: WalkCommands,
}

#[derive(Subcommand)]
enum WalkCommands {
    /// Start a walk (a fresh Chrome window, narrated) or a diatribe (screen and voice) in the app
    Start(WalkStart),
    /// Stop a walk started with `walk start`; it then saves and processes as usual
    Stop(WalkStop),
    /// Show where a walk stands: starting, recording, stopping, processing, ready or failed
    Status(WalkStatus),
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Mode {
    /// A walk: a fresh Chrome window, narrated. Its value is kept stable for callers.
    #[value(name = "worm")]
    Walk,
    Diatribe,
}

#[derive(Args)]
struct WalkStart {
    #[arg(long, value_enum, default_value_t = Mode::Walk)]
    mode: Mode,
    /// What the walk is about; names its folder
    #[arg(long)]
    topic: String,
    /// Start page for a walk's Chrome window (default: the start page in walk settings)
    #[arg(long)]
    url: Option<String>,
    /// Your own id for this walk (letters, digits, - and _); a new one is made if left out
    #[arg(long)]
    id: Option<String>,
    /// Seconds to wait for the recording to begin before returning its state as it stands
    #[arg(long, default_value_t = 60)]
    timeout: u64,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct WalkStop {
    id: String,
    /// Wait until the walk is processed (ready or failed) and print its final state
    #[arg(long)]
    wait: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct WalkStatus {
    id: String,
    /// Print each change as it happens (one JSON object per line with --json) until it ends
    #[arg(long)]
    follow: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

/// How long the app has to write a walk's first status after the deep link is sent. Longer
/// than any start: a missing file after this means the installed app predates `start_walk`
/// or is not answering.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(250);

impl WalkArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            WalkCommands::Start(args) => {
                let format = resolve_format(json, args.format);
                finish(format, start(args).await)
            }
            WalkCommands::Stop(args) => {
                let format = resolve_format(json, args.format);
                finish(format, stop(args).await)
            }
            WalkCommands::Status(args) => {
                let format = resolve_format(json, args.format);
                if args.follow {
                    return finish_streamed(format, follow(&args.id, format, true).await);
                }
                finish(
                    format,
                    read(&directory(), &args.id).ok_or_else(|| unknown(&args.id)),
                )
            }
        }
    }
}

pub fn directory() -> PathBuf {
    std::env::var_os("CAP_UX_WALK_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config/ux-walk"))
        .join("external-walks")
}

pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn read(directory: &Path, id: &str) -> Option<Value> {
    if !valid_id(id) {
        return None;
    }
    let bytes = std::fs::read(directory.join(format!("{id}.json"))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn state(status: &Value) -> &str {
    status["state"].as_str().unwrap_or_default()
}

fn is_final(status: &Value) -> bool {
    matches!(state(status), "ready" | "failed")
}

fn unknown(id: &str) -> String {
    format!("No walk with id {id}.")
}

/// The `start_walk` deep link, in the app's `DeepLinkAction` grammar.
pub fn start_link(id: &str, mode: &str, topic: &str, url: Option<&str>) -> String {
    action_link(&json!({ "start_walk": { "id": id, "mode": mode, "topic": topic, "url": url } }))
}

pub fn stop_link(id: &str) -> String {
    action_link(&json!({ "stop_walk": { "id": id } }))
}

fn action_link(value: &Value) -> String {
    let mut url = reqwest::Url::parse(&format!("{}://action", fork_brand::URL_SCHEME))
        .expect("the brand's URL scheme is valid");
    url.query_pairs_mut()
        .append_pair("value", &value.to_string());
    url.into()
}

/// The app bundle this CLI ships in, so a walk goes to the same build; else the installed app.
fn app_bundle() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?.canonicalize().ok()?;
    let contents = executable.parent()?.parent()?;
    let bundle = contents.parent()?;
    (bundle.extension()? == "app" && contents.join("Info.plist").exists())
        .then(|| bundle.to_path_buf())
}

fn send(link: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Walks from the command line need the macOS app.".into());
    }
    let mut open = std::process::Command::new("/usr/bin/open");
    open.arg("-g");
    match app_bundle() {
        Some(bundle) => open.arg("-a").arg(bundle),
        None => open.arg("-b").arg(fork_brand::BUNDLE_ID),
    };
    let status = open
        .arg(link)
        .status()
        .map_err(|error| format!("Could not reach the app: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open the app. Is it installed?".into())
    }
}

async fn start(args: WalkStart) -> Result<Value, String> {
    let id = args.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if !valid_id(&id) {
        return Err("Use only letters, digits, - and _ in a walk id (64 at most).".into());
    }
    let directory = directory();
    if read(&directory, &id).is_some() {
        return Err(format!("A walk with id {id} already exists."));
    }
    let mode = match args.mode {
        Mode::Walk => "worm",
        Mode::Diatribe => "diatribe",
    };
    send(&start_link(&id, mode, &args.topic, args.url.as_deref()))?;
    let begun = Instant::now();
    let deadline = Duration::from_secs(args.timeout);
    loop {
        match read(&directory, &id) {
            Some(status) if state(&status) != "starting" || begun.elapsed() >= deadline => {
                return match status["error"].as_str() {
                    Some(error) if state(&status) == "failed" => Err(error.to_string()),
                    _ => Ok(status),
                };
            }
            None if begun.elapsed() >= ANSWER_TIMEOUT.min(deadline.max(POLL)) => {
                return Err(
                    "The app did not answer. Update it to a build with outside walks, and check that it can open."
                        .into(),
                );
            }
            _ => tokio::time::sleep(POLL).await,
        }
    }
}

async fn stop(args: WalkStop) -> Result<Value, String> {
    let directory = directory();
    let status = read(&directory, &args.id).ok_or_else(|| unknown(&args.id))?;
    if !is_final(&status) {
        send(&stop_link(&args.id))?;
    }
    if !args.wait {
        return Ok(read(&directory, &args.id).unwrap_or(status));
    }
    let status = follow(&args.id, OutputFormat::Text, false).await?;
    match status["error"].as_str() {
        Some(error) if state(&status) == "failed" => Err(error.to_string()),
        _ => Ok(status),
    }
}

/// Reads the status until it is final, printing each change when `print` is on, and returns
/// the final status.
async fn follow(id: &str, format: OutputFormat, print: bool) -> Result<Value, String> {
    let directory = directory();
    let mut last: Option<Value> = None;
    let mut missing = Duration::ZERO;
    loop {
        match read(&directory, id) {
            Some(status) => {
                if last.as_ref() != Some(&status) {
                    if print {
                        match format {
                            OutputFormat::Json => write_json_line(&status)?,
                            OutputFormat::Text => print_text(&status),
                        }
                    }
                    if is_final(&status) {
                        return Ok(status);
                    }
                    last = Some(status);
                }
            }
            None if missing >= ANSWER_TIMEOUT => return Err(unknown(id)),
            None => missing += POLL,
        }
        tokio::time::sleep(POLL).await;
    }
}

fn print_text(status: &Value) {
    println!(
        "{}: {}",
        state(status),
        status["step"].as_str().unwrap_or_default()
    );
    if is_final(status)
        && let Some(folder) = status["folder"].as_str()
    {
        println!("folder: {folder}");
    }
}

fn finish(format: OutputFormat, result: Result<Value, String>) -> Result<(), String> {
    match (format, result) {
        (OutputFormat::Json, Ok(status)) => write_json(&status),
        (OutputFormat::Text, Ok(status)) => {
            print_text(&status);
            if !is_final(&status) {
                println!("id: {}", status["id"].as_str().unwrap_or_default());
            }
            Ok(())
        }
        (OutputFormat::Json, Err(error)) => {
            let _ = write_json(&json!({ "error": error }));
            Err(error)
        }
        (OutputFormat::Text, Err(error)) => Err(error),
    }
}

/// `--follow` already printed each state; only a failure needs a last word.
fn finish_streamed(format: OutputFormat, result: Result<Value, String>) -> Result<(), String> {
    match result {
        Ok(status) if state(&status) == "failed" => Err(status["error"]
            .as_str()
            .unwrap_or("The walk failed.")
            .to_string()),
        Ok(_) => Ok(()),
        Err(error) => {
            if format == OutputFormat::Json {
                let _ = write_json_line(&json!({ "error": error }));
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(link: &str) -> Value {
        let url = reqwest::Url::parse(link).unwrap();
        assert_eq!(url.scheme(), fork_brand::URL_SCHEME);
        assert_eq!(url.host_str(), Some("action"));
        let (_, value) = url.query_pairs().find(|(key, _)| key == "value").unwrap();
        serde_json::from_str(&value).unwrap()
    }

    #[test]
    fn links_use_the_apps_action_grammar() {
        assert_eq!(
            decode(&start_link(
                "run-1",
                "worm",
                "Check out & pay",
                Some("https://x.test/?a=1")
            )),
            json!({ "start_walk": {
                "id": "run-1", "mode": "worm", "topic": "Check out & pay", "url": "https://x.test/?a=1"
            }})
        );
        assert_eq!(
            decode(&start_link("run-2", "diatribe", "Pricing", None)),
            json!({ "start_walk": { "id": "run-2", "mode": "diatribe", "topic": "Pricing", "url": null } })
        );
        assert_eq!(
            decode(&stop_link("run-2")),
            json!({ "stop_walk": { "id": "run-2" } })
        );
    }

    #[test]
    fn reads_only_plain_ids_from_the_status_folder() {
        let directory =
            std::env::temp_dir().join(format!("cli-external-walks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("run-1.json"),
            r#"{"schemaVersion":1,"id":"run-1","state":"ready","folder":"/w","error":null}"#,
        )
        .unwrap();
        let status = read(&directory, "run-1").unwrap();
        assert!(is_final(&status));
        assert_eq!(status["folder"], "/w");
        assert!(read(&directory, "../run-1").is_none());
        assert!(read(&directory, "missing").is_none());
        std::fs::remove_dir_all(directory).ok();
    }
}
