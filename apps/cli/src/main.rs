mod automation;
mod credentials;
mod doctor;
mod export;
mod guide;
mod project;
mod record;
mod recordings;
mod screenshot;
mod session;
mod targets;
mod update;
mod upload;

use std::{
    io::{Write, stderr, stdout},
    path::PathBuf,
};

use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};
use export::{Export, ExportPreview};
use record::RecordStart;
use serde::Serialize;
use tracing_subscriber::{filter::LevelFilter, layer::SubscriberExt, util::SubscriberInitExt};

const TOKIO_WORKER_THREAD_STACK_SIZE: usize = 16 * 1024 * 1024;

/// Long-form help epilogue. Agents read `cap --help` before doing anything, so the conventions they
/// need to drive the CLI correctly (JSON on stdout, env vars, the canonical workflow) live here.
const AGENT_HELP: &str = "\
OUTPUT
  Pass --json (global) for machine-readable JSON on stdout; stderr stays human-readable.
  stdout is the authoritative result. On failure the process exits non-zero and, in --json
  mode, prints a final object/event containing an \"error\" field. Streaming commands (record,
  export) emit newline-delimited JSON (NDJSON) events. Run `cap guide --json` for the full
  machine-readable capability + schema manifest.

AUTH
  `cap upload` authenticates automatically by reusing the login Cap Desktop already stored — no
  key to copy when you are signed in there. Check with `cap auth status --json`. For headless/CI,
  set CAP_API_KEY to a Cap auth key (Settings) to override.

ENVIRONMENT
  CAP_API_KEY         Overrides auth for `cap upload` (Cap auth key from Settings); optional when
                      signed into Cap Desktop.
  CAP_SERVER_URL      Cap server base URL; defaults to Cap Desktop's server, else https://cap.so.
  CAP_NO_MODIFY_PATH  Set to skip editing shell profiles during `cap desktop install-cli`.
  CAP_DESKTOP_FORCE_INSTALL
                      Force the web installer scripts to replace Cap Desktop before linking the CLI.

TYPICAL AGENT WORKFLOW
  cap doctor --json                          # verify permissions & capture readiness
  cap targets --json                         # discover screens/windows/cameras/mics
  cap record start --screen <id> --json --detach  # start in background -> {recordingId, pid, path}
  cap record stop --id <recordingId> --json  # finalize the .cap recording
  cap project validate <path.cap> --json     # confirm the recording is complete
  cap export <path.cap> --output out.mp4 --json
  cap upload out.mp4 --json                   # get a shareable link (needs CAP_API_KEY)";

#[derive(Parser)]
#[command(
    name = "cap",
    version,
    about = "Cap screen recording from the command line",
    long_about = "Cap screen recording from the command line.\n\nDesigned to be driven by automation and AI agents: add --json to any command for \
machine-readable output. See the sections below for the JSON convention, environment variables, and \
the canonical record -> export -> upload workflow.",
    after_help = AGENT_HELP,
    after_long_help = AGENT_HELP
)]
struct Cli {
    #[arg(long, value_enum, global = true, default_value_t = CliLogLevel::Warn)]
    log_level: CliLogLevel,
    /// Emit machine-readable JSON to stdout (overrides each command's --format)
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum CliLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl CliLogLevel {
    fn level_filter(self) -> LevelFilter {
        match self {
            Self::Trace => LevelFilter::TRACE,
            Self::Debug => LevelFilter::DEBUG,
            Self::Info => LevelFilter::INFO,
            Self::Warn => LevelFilter::WARN,
            Self::Error => LevelFilter::ERROR,
        }
    }
}

#[derive(Subcommand)]
enum Commands {
    /// Export a '.cap' project to a video file
    Export(Export),
    /// Render an export preview frame
    ExportPreview(ExportPreview),
    /// Inspect or validate a '.cap' project
    Project(ProjectArgs),
    /// Start a recording or list available capture targets and devices
    Record(RecordArgs),
    /// Capture a still screenshot of a screen or window
    Screenshot(screenshot::Screenshot),
    /// List recordings discovered in the desktop library (or a custom directory)
    Recordings(RecordingsArgs),
    /// Upload a recording or video file and get a shareable link
    Upload(upload::UploadArgs),
    /// Update Cap Desktop and the bundled CLI
    Update(FormatArgs),
    /// Show how `cap upload` will authenticate (env key or Cap Desktop login)
    Auth(AuthArgs),
    /// List available capture targets and devices
    Targets(TargetsArgs),
    /// Report CLI environment and capture-readiness diagnostics
    Doctor(FormatArgs),
    /// Print CLI version and execution context
    Version(FormatArgs),
    /// Inspect or manage the desktop-installed `cap` shim
    Desktop(DesktopArgs),
    /// Print the machine-readable capability & JSON-schema manifest for agents
    Guide(FormatArgs),
    /// List automation rules shared with Cap Desktop
    Automations(AutomationsArgs),
    /// Generate shell completion scripts
    Completions(CompletionsArgs),
}

impl Commands {
    fn exit_after_success(&self) -> bool {
        matches!(self, Self::Export(_) | Self::ExportPreview(_))
    }
}

#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
struct RecordArgs {
    #[command(subcommand)]
    command: Option<RecordCommands>,

    #[command(flatten)]
    args: RecordStart,
}

#[derive(Subcommand)]
enum RecordCommands {
    /// Start a recording (use --detach to run in the background and stop later)
    Start(RecordStart),
    /// Stop a detached recording started with `cap record start --detach`
    Stop(record::RecordStopArgs),
    /// List active and recent detached recording sessions
    Status(FormatArgs),
    /// Internal: background worker for detached recordings (do not call directly)
    #[command(name = "__session-run", hide = true)]
    SessionRun(record::SessionRunArgs),
    /// List screens available for capturing
    Screens(FormatArgs),
    /// List windows available for capturing
    Windows(FormatArgs),
    /// List cameras available for capturing
    Cameras(FormatArgs),
    /// List microphones available for capturing
    Mics(FormatArgs),
}

#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
struct TargetsArgs {
    #[command(subcommand)]
    command: Option<TargetCommands>,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Subcommand)]
enum TargetCommands {
    /// List screens available for capturing
    Screens(FormatArgs),
    /// List windows available for capturing
    Windows(FormatArgs),
    /// List cameras available for capturing
    Cameras(FormatArgs),
    /// List microphones available for capturing
    Mics(FormatArgs),
}

#[derive(Args)]
struct FormatArgs {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
}

#[derive(Args)]
struct ProjectArgs {
    #[command(subcommand)]
    command: ProjectCommands,
}

#[derive(Subcommand)]
enum ProjectCommands {
    /// Print project metadata and editor configuration
    Inspect(ProjectTarget),
    /// Verify a project's metadata and expected media files exist
    Validate(ProjectTarget),
    /// Read or write a project's editor configuration (project-config.json)
    Config(ProjectConfigArgs),
}

#[derive(Args)]
struct ProjectTarget {
    project_path: PathBuf,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct ProjectConfigArgs {
    #[command(subcommand)]
    command: ProjectConfigCommands,
}

#[derive(Subcommand)]
enum ProjectConfigCommands {
    /// Print the project's editor configuration as JSON
    Get(ProjectTarget),
    /// Replace the project's editor configuration from a full JSON document
    Set(ProjectConfigSet),
}

#[derive(Args)]
struct ProjectConfigSet {
    project_path: PathBuf,
    /// Full ProjectConfiguration as a JSON string (camelCase keys); omitted fields reset to defaults
    #[arg(long)]
    settings_json: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct RecordingsArgs {
    #[command(subcommand)]
    command: RecordingsCommands,
}

#[derive(Subcommand)]
enum RecordingsCommands {
    /// List '.cap' recordings discovered on disk
    List(RecordingsListArgs),
}

#[derive(Args)]
struct RecordingsListArgs {
    /// Directory to scan (defaults to the desktop recordings library)
    #[arg(long)]
    dir: Option<PathBuf>,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DesktopArgs {
    #[command(subcommand)]
    command: DesktopCommands,
}

#[derive(Subcommand)]
enum DesktopCommands {
    /// Show whether the `cap` shim is installed and on PATH
    Status(FormatArgs),
    /// Install the `cap` shim onto your PATH
    InstallCli(FormatArgs),
    /// Remove the `cap` shim from your PATH
    UninstallCli(FormatArgs),
}

#[derive(Args)]
struct AuthArgs {
    #[command(subcommand)]
    command: AuthCommands,
}

#[derive(Subcommand)]
enum AuthCommands {
    /// Report whether a credential is available and where it comes from (never prints the secret)
    Status(FormatArgs),
}

#[derive(Args)]
struct AutomationsArgs {
    #[command(subcommand)]
    command: AutomationsCommands,
}

#[derive(Subcommand)]
enum AutomationsCommands {
    /// List the automation rules configured in Cap Desktop
    List(FormatArgs),
}

#[derive(Args)]
struct CompletionsArgs {
    #[arg(value_enum)]
    shell: clap_complete::Shell,
}

fn main() {
    let cli = Cli::parse();
    let level_filter = cli.log_level.level_filter();

    let registry = tracing_subscriber::registry().with(tracing_subscriber::filter::filter_fn(
        // The binary crate is named `cap`, so its own spans/events have target `cap`/`cap::…`,
        // which a bare `cap_` prefix excludes — keep those alongside the `cap_*` library crates.
        (|v| {
            let target = v.target();
            target == "cap" || target.starts_with("cap::") || target.starts_with("cap_")
        }) as fn(&tracing::Metadata) -> bool,
    ));

    registry
        .with(level_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(true)
                .with_writer(stderr),
        )
        .init();

    let exit_after_success = cli.command.exit_after_success();

    // Windows export exercises deep WGPU/MediaFoundation/FFmpeg stacks. Running the CLI runtime
    // on an explicitly large stack is what stopped the export worker from overflowing before
    // the first frame; keep the sidecar and desktop runtimes in sync.
    let runtime_thread = std::thread::Builder::new()
        .name("cap-cli-runtime".to_string())
        .stack_size(TOKIO_WORKER_THREAD_STACK_SIZE)
        .spawn(move || -> Result<(), String> {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(TOKIO_WORKER_THREAD_STACK_SIZE)
                .build()
                .map_err(|e| format!("Failed to build Tokio runtime: {e}"))?;

            let result = runtime.block_on(run(cli));
            if exit_after_success && result.is_ok() {
                // Successful export/preview workers have already written their output by here.
                // Exiting directly avoids Windows GPU/MediaFoundation teardown crashes in the
                // short-lived sidecar process.
                let _ = stdout().flush();
                let _ = stderr().flush();
                std::process::exit(0);
            }

            result
        });

    // Surface failures as a clean, unquoted `error: ...` line on stderr (the default
    // `Result`-returning main prints `Error: "debug-quoted"`, which is noisy for humans and brittle
    // for agents scraping stderr). clap already exits 2 for usage/parse errors before we get here.
    let outcome = match runtime_thread {
        Ok(handle) => handle.join(),
        Err(e) => {
            eprintln!("error: Failed to spawn CLI runtime thread: {e}");
            std::process::exit(1);
        }
    };

    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(message)) => {
            eprintln!("error: {message}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("error: CLI runtime thread panicked");
            std::process::exit(1);
        }
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    let json = cli.json;
    match cli.command {
        Commands::Export(e) => e.run(json).await,
        Commands::ExportPreview(e) => e.run().await,
        Commands::Project(args) => args.run(json),
        Commands::Record(RecordArgs { command, args }) => match command {
            Some(RecordCommands::Start(args)) => args.run(json).await,
            Some(RecordCommands::Stop(args)) => args.run(json).await,
            Some(RecordCommands::Status(args)) => {
                let format = resolve_format(json, args.format);
                finish_json(format, record::status(format))
            }
            Some(RecordCommands::SessionRun(args)) => args.run().await,
            Some(RecordCommands::Screens(args)) => {
                let format = resolve_format(json, args.format);
                finish_json(format, targets::print_screens(format))
            }
            Some(RecordCommands::Windows(args)) => {
                let format = resolve_format(json, args.format);
                finish_json(format, targets::print_windows(format))
            }
            Some(RecordCommands::Cameras(args)) => {
                let format = resolve_format(json, args.format);
                finish_json(format, targets::print_cameras(format))
            }
            Some(RecordCommands::Mics(args)) => {
                let format = resolve_format(json, args.format);
                finish_json(format, targets::print_mics(format))
            }
            None => args.run(json).await,
        },
        Commands::Screenshot(s) => s.run(json).await,
        Commands::Recordings(args) => args.run(json),
        Commands::Upload(args) => args.run(json).await,
        Commands::Update(args) => {
            let format = resolve_format(json, args.format);
            finish_json(format, update::run(format))
        }
        Commands::Auth(args) => match args.command {
            AuthCommands::Status(args) => {
                let format = resolve_format(json, args.format);
                finish_json(format, credentials::status(format))
            }
        },
        Commands::Targets(args) => args.run(json),
        Commands::Doctor(args) => doctor::run_doctor(resolve_format(json, args.format)),
        Commands::Version(args) => {
            let format = resolve_format(json, args.format);
            finish_json(format, doctor::run_version(format))
        }
        Commands::Desktop(args) => args.run(json),
        Commands::Guide(args) => {
            let format = resolve_format(json, args.format);
            finish_json(format, guide::run(format))
        }
        Commands::Automations(args) => match args.command {
            AutomationsCommands::List(a) => {
                let format = resolve_format(json, a.format);
                finish_json(format, automation::list(format))
            }
        },
        Commands::Completions(args) => {
            args.run();
            Ok(())
        }
    }
}

/// `--json` is a global convenience that forces JSON regardless of a command's local `--format`
/// (which stays for back-compat). Either one selecting JSON wins.
pub fn resolve_format(global_json: bool, local: OutputFormat) -> OutputFormat {
    if global_json {
        OutputFormat::Json
    } else {
        local
    }
}

impl TargetsArgs {
    fn run(self, json: bool) -> Result<(), String> {
        let (format, result) = match self.command {
            Some(TargetCommands::Screens(args)) => {
                let format = resolve_format(json, args.format);
                (format, targets::print_screens(format))
            }
            Some(TargetCommands::Windows(args)) => {
                let format = resolve_format(json, args.format);
                (format, targets::print_windows(format))
            }
            Some(TargetCommands::Cameras(args)) => {
                let format = resolve_format(json, args.format);
                (format, targets::print_cameras(format))
            }
            Some(TargetCommands::Mics(args)) => {
                let format = resolve_format(json, args.format);
                (format, targets::print_mics(format))
            }
            None => {
                let format = resolve_format(json, self.format);
                (format, targets::print_all(format))
            }
        };
        finish_json(format, result)
    }
}

impl ProjectArgs {
    fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            // validate emits its own structured report (incl. JSON errors), so it is not wrapped.
            ProjectCommands::Validate(args) => {
                project::validate(args.project_path, resolve_format(json, args.format))
            }
            ProjectCommands::Inspect(args) => {
                let format = resolve_format(json, args.format);
                finish_json(format, project::inspect(args.project_path, format))
            }
            ProjectCommands::Config(ProjectConfigArgs { command }) => match command {
                ProjectConfigCommands::Get(args) => finish_json(
                    resolve_format(json, args.format),
                    project::config_get(args.project_path),
                ),
                ProjectConfigCommands::Set(args) => {
                    let format = resolve_format(json, args.format);
                    finish_json(
                        format,
                        project::config_set(args.project_path, &args.settings_json, format),
                    )
                }
            },
        }
    }
}

impl RecordingsArgs {
    fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            RecordingsCommands::List(args) => {
                let format = resolve_format(json, args.format);
                finish_json(format, recordings::list(args.dir, format))
            }
        }
    }
}

impl DesktopArgs {
    fn run(self, json: bool) -> Result<(), String> {
        let (format, result) = match self.command {
            DesktopCommands::Status(args) => {
                let format = resolve_format(json, args.format);
                (
                    format,
                    emit_install_status(cap_cli_install::status(), format),
                )
            }
            DesktopCommands::InstallCli(args) => {
                let format = resolve_format(json, args.format);
                (
                    format,
                    emit_install_status(cap_cli_install::install(), format),
                )
            }
            DesktopCommands::UninstallCli(args) => {
                let format = resolve_format(json, args.format);
                (
                    format,
                    emit_install_status(cap_cli_install::uninstall(), format),
                )
            }
        };
        finish_json(format, result)
    }
}

/// When `--format json` is requested and a command fails before it could emit its own structured
/// output, write a machine-readable `{"error": "..."}` to stdout so agents do not have to scrape
/// the human-readable stderr line. The original `Err` still propagates for a non-zero exit code.
fn finish_json(format: OutputFormat, result: Result<(), String>) -> Result<(), String> {
    if format == OutputFormat::Json
        && let Err(message) = &result
    {
        let _ = write_json(&serde_json::json!({ "error": message }));
    }
    result
}

fn emit_install_status(
    status: Result<cap_cli_install::CliInstallStatus, String>,
    format: OutputFormat,
) -> Result<(), String> {
    let status = status?;
    match format {
        OutputFormat::Json => write_json(&status),
        OutputFormat::Text => {
            println!("install dir: {}", status.install_dir);
            println!("shim: {}", status.shim_path);
            println!("target: {}", status.target_path);
            println!("installed: {}", status.installed);
            println!("on PATH: {}", status.on_path);
            if let Some(conflict) = &status.conflict {
                println!("conflict: {conflict}");
            }
            if !status.on_path {
                if status.path_configured {
                    println!(
                        "PATH updated; restart your terminal or run: {}",
                        status.shell_command
                    );
                } else {
                    println!("add to PATH: {}", status.shell_command);
                }
            }
            Ok(())
        }
    }
}

impl CompletionsArgs {
    fn run(self) {
        let mut cmd = Cli::command();
        let name = cmd.get_name().to_string();
        clap_complete::generate(self.shell, &mut cmd, name, &mut stdout());
    }
}

pub fn write_json<T: Serialize>(value: &T) -> Result<(), String> {
    let mut stdout = stdout();
    serde_json::to_writer_pretty(&mut stdout, value).map_err(|e| e.to_string())?;
    writeln!(&mut stdout).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

pub fn write_json_line<T: Serialize>(value: &T) -> Result<(), String> {
    let mut stdout = stdout();
    serde_json::to_writer(&mut stdout, value).map_err(|e| e.to_string())?;
    writeln!(&mut stdout).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}
