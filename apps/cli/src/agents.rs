use std::{
    io::IsTerminal,
    path::{Path, PathBuf},
};

use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;
use serde_json::{Map, Value, json};
use toml_edit::{Array, DocumentMut, Item, Table, value};

use crate::{OutputFormat, atomic, resolve_format, write_json};

const BUNDLED_SKILL: &str = include_str!("../skill/cap/SKILL.md");

#[derive(Args)]
pub struct AgentsArgs {
    #[command(subcommand)]
    command: AgentsCommands,
}

#[derive(Subcommand)]
enum AgentsCommands {
    Install(InstallArgs),
}

#[derive(Clone, Copy, ValueEnum)]
enum AgentTarget {
    Codex,
    Claude,
    Cursor,
}

#[derive(Clone, Copy, ValueEnum)]
enum AgentComponent {
    Skill,
    Mcp,
    All,
}

#[derive(Args)]
struct InstallArgs {
    #[arg(long, value_enum)]
    target: AgentTarget,
    #[arg(long, value_enum)]
    component: AgentComponent,
    #[arg(long)]
    dry_run: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedChange {
    component: &'static str,
    path: PathBuf,
    action: &'static str,
    value: Value,
    #[serde(skip)]
    expected: Option<Vec<u8>>,
    #[serde(skip)]
    content: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    target: &'static str,
    dry_run: bool,
    applied: bool,
    changes: Vec<PlannedChange>,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not locate the home directory".to_string())
}

fn target_name(target: AgentTarget) -> &'static str {
    match target {
        AgentTarget::Codex => "codex",
        AgentTarget::Claude => "claude",
        AgentTarget::Cursor => "cursor",
    }
}

fn skill_path(target: AgentTarget) -> Result<PathBuf, String> {
    let home = home_dir()?;
    Ok(match target {
        AgentTarget::Codex => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("skills/cap/SKILL.md"),
        AgentTarget::Claude => home.join(".claude/skills/cap/SKILL.md"),
        AgentTarget::Cursor => home.join(".cursor/skills/cap/SKILL.md"),
    })
}

fn mcp_path(target: AgentTarget) -> Result<PathBuf, String> {
    let home = home_dir()?;
    Ok(match target {
        AgentTarget::Codex => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("config.toml"),
        AgentTarget::Claude => home.join(".claude.json"),
        AgentTarget::Cursor => home.join(".cursor/mcp.json"),
    })
}

fn atomic_write(path: &Path, content: &[u8], private: bool) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = private;
    let parent = path
        .parent()
        .ok_or_else(|| "Install path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, content).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::metadata(path)
            .map(|metadata| metadata.permissions())
            .unwrap_or_else(|_| {
                std::fs::Permissions::from_mode(if private { 0o600 } else { 0o644 })
            });
        std::fs::set_permissions(&temporary, permissions).map_err(|error| error.to_string())?;
    }
    if let Err(error) = atomic::replace(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn print_changes(changes: &[PlannedChange]) -> Result<(), String> {
    for change in changes {
        println!(
            "{} {}: {}",
            change.action,
            change.component,
            change.path.display()
        );
        println!(
            "  {}",
            serde_json::to_string(&change.value).map_err(|error| error.to_string())?
        );
    }
    Ok(())
}

fn mcp_value() -> Value {
    json!({ "command": "cap", "args": ["mcp", "serve"] })
}

fn merge_json_mcp(existing: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut document = match existing {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).map_err(|error| error.to_string())?,
        None => json!({}),
    };
    let object = document
        .as_object_mut()
        .ok_or_else(|| "MCP configuration must be a JSON object".to_string())?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "mcpServers must be a JSON object".to_string())?;
    if let Some(current) = servers.get("cap")
        && current != &mcp_value()
    {
        return Err("An incompatible MCP server named 'cap' already exists".to_string());
    }
    servers.insert("cap".to_string(), mcp_value());
    serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())
}

fn merge_codex_mcp(existing: Option<&str>) -> Result<Vec<u8>, String> {
    let mut document = existing
        .unwrap_or_default()
        .parse::<DocumentMut>()
        .map_err(|error| error.to_string())?;
    if !document.as_table().contains_key("mcp_servers") {
        document["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = document["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| "mcp_servers must be a TOML table".to_string())?;
    if let Some(current) = servers.get("cap") {
        let command = current.get("command").and_then(Item::as_str);
        let args = current.get("args").and_then(Item::as_array);
        let compatible = command == Some("cap")
            && args.is_some_and(|args| {
                args.len() == 2
                    && args.get(0).and_then(toml_edit::Value::as_str) == Some("mcp")
                    && args.get(1).and_then(toml_edit::Value::as_str) == Some("serve")
            });
        if !compatible {
            return Err("An incompatible MCP server named 'cap' already exists".to_string());
        }
    }
    servers["cap"]["command"] = value("cap");
    let mut args = Array::new();
    args.push("mcp");
    args.push("serve");
    servers["cap"]["args"] = value(args);
    Ok(document.to_string().into_bytes())
}

fn confirm() -> Result<(), String> {
    if !std::io::stdin().is_terminal() {
        return Err("Non-interactive installation requires --yes".to_string());
    }
    eprint!("Apply these changes? [y/N] ");
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|error| error.to_string())?;
    if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        return Err("Installation cancelled".to_string());
    }
    Ok(())
}

impl InstallArgs {
    fn includes_skill(&self) -> bool {
        matches!(self.component, AgentComponent::Skill | AgentComponent::All)
    }

    fn includes_mcp(&self) -> bool {
        matches!(self.component, AgentComponent::Mcp | AgentComponent::All)
    }

    fn plan(&self) -> Result<Vec<PlannedChange>, String> {
        let mut changes = Vec::new();
        if self.includes_skill() {
            let path = skill_path(self.target)?;
            let expected = read_optional(&path)?;
            let action = if expected.as_deref() == Some(BUNDLED_SKILL.as_bytes()) {
                "unchanged"
            } else if expected.is_some() {
                "replace"
            } else {
                "create"
            };
            let content = (action != "unchanged").then(|| BUNDLED_SKILL.as_bytes().to_vec());
            changes.push(PlannedChange {
                component: "skill",
                path,
                action,
                value: json!({ "name": "cap", "content": BUNDLED_SKILL }),
                expected,
                content,
            });
        }
        if self.includes_mcp() {
            let path = mcp_path(self.target)?;
            let expected = read_optional(&path)?;
            let merged = if matches!(self.target, AgentTarget::Codex) {
                let text = expected
                    .as_deref()
                    .map(std::str::from_utf8)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                merge_codex_mcp(text)?
            } else {
                merge_json_mcp(expected.as_deref())?
            };
            let unchanged = expected.as_deref() == Some(merged.as_slice());
            changes.push(PlannedChange {
                component: "mcp",
                action: if unchanged {
                    "unchanged"
                } else if expected.is_some() {
                    "merge"
                } else {
                    "create"
                },
                path,
                value: json!({ "name": "cap", "command": "cap", "args": ["mcp", "serve"] }),
                expected,
                content: (!unchanged).then_some(merged),
            });
        }
        Ok(changes)
    }

    fn apply(&self, changes: &[PlannedChange]) -> Result<(), String> {
        for change in changes {
            if read_optional(&change.path)? != change.expected {
                return Err(format!(
                    "{} changed after the installation preview; review a new preview before applying",
                    change.path.display()
                ));
            }
        }
        for change in changes {
            if let Some(content) = &change.content {
                atomic_write(&change.path, content, change.component == "mcp")?;
            }
        }
        Ok(())
    }
}

impl AgentsArgs {
    pub fn run(self, global_json: bool) -> Result<(), String> {
        let format = match &self.command {
            AgentsCommands::Install(args) => resolve_format(global_json, args.format),
        };
        let result = self.run_inner(global_json);
        if let Err(error) = &result
            && format == OutputFormat::Json
        {
            let _ = write_json(&json!({ "error": error }));
        }
        result
    }

    fn run_inner(self, global_json: bool) -> Result<(), String> {
        match self.command {
            AgentsCommands::Install(args) => {
                let format = resolve_format(global_json, args.format);
                let changes = args.plan()?;
                if args.dry_run {
                    let result = InstallResult {
                        target: target_name(args.target),
                        dry_run: true,
                        applied: false,
                        changes,
                    };
                    return match format {
                        OutputFormat::Json => write_json(&result),
                        OutputFormat::Text => print_changes(&result.changes),
                    };
                }
                if format == OutputFormat::Text {
                    print_changes(&changes)?;
                } else if !args.yes {
                    eprintln!(
                        "{}",
                        serde_json::to_string_pretty(&changes).map_err(|error| error.to_string())?
                    );
                }
                if !args.yes {
                    confirm()?;
                }
                args.apply(&changes)?;
                let result = InstallResult {
                    target: target_name(args.target),
                    dry_run: false,
                    applied: true,
                    changes,
                };
                match format {
                    OutputFormat::Json => write_json(&result),
                    OutputFormat::Text => {
                        println!("Installed Cap agent components for {}.", result.target);
                        Ok(())
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_merge_preserves_unrelated_servers() {
        let merged = merge_json_mcp(Some(
            br#"{"mcpServers":{"other":{"command":"other"}},"setting":true}"#,
        ))
        .unwrap();
        let value: Value = serde_json::from_slice(&merged).unwrap();
        assert_eq!(value["setting"], true);
        assert_eq!(value["mcpServers"]["other"]["command"], "other");
        assert_eq!(value["mcpServers"]["cap"], mcp_value());
    }

    #[test]
    fn codex_merge_rejects_conflicting_cap_server() {
        let error = merge_codex_mcp(Some(
            "[mcp_servers.cap]\ncommand = \"different\"\nargs = []\n",
        ))
        .unwrap_err();
        assert!(error.contains("incompatible"));
    }

    #[test]
    fn codex_merge_is_stable() {
        let original = "[mcp_servers.cap]\ncommand = \"cap\"\nargs = [\"mcp\", \"serve\"]\n";
        assert_eq!(
            merge_codex_mcp(Some(original)).unwrap(),
            original.as_bytes()
        );
    }
}
