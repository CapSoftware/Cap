use clap::{Args, ValueEnum};

use crate::{OutputFormat, agent_client};

#[derive(Clone, Copy, ValueEnum)]
enum AnalyticsRange {
    Day,
    Week,
    Month,
    Year,
}

impl AnalyticsRange {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
        }
    }
}

#[derive(Args)]
pub struct AnalyticsArgs {
    #[arg(long)]
    organization: String,
    #[arg(long)]
    space: Option<String>,
    #[arg(long)]
    cap: Option<String>,
    #[arg(long, value_enum, default_value_t = AnalyticsRange::Month)]
    range: AnalyticsRange,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

impl AnalyticsArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        let query = agent_client::query(&[
            ("organizationId", Some(self.organization)),
            ("spaceId", self.space),
            ("capId", self.cap),
            ("range", Some(self.range.as_str().to_string())),
        ]);
        agent_client::read(&format!("/analytics?{query}"), global_json, self.format).await
    }
}
