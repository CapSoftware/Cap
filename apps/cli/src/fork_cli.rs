use clap::{Command, CommandFactory, FromArgMatches};

use crate::Cli;

pub fn command() -> Command {
    if cfg!(feature = "ux-walk") {
        rebrand(Cli::command()).name(fork_brand::CLI_NAME)
    } else {
        Cli::command()
    }
}

pub fn parse() -> Cli {
    let mut command = command();
    let mut matches = command.clone().get_matches();
    Cli::from_arg_matches_mut(&mut matches)
        .unwrap_or_else(|error| error.format(&mut command).exit())
}

fn rebrand(command: Command) -> Command {
    let branded = |text: &clap::builder::StyledStr| fork_brand::cli_text(&text.to_string());
    let about = command.get_about().map(branded);
    let long_about = command.get_long_about().map(branded);
    let mut command = command.mut_args(rebrand_arg).mut_subcommands(rebrand);
    if let Some(about) = about {
        command = command.about(about);
    }
    if let Some(long_about) = long_about {
        command = command.long_about(long_about);
    }
    command
}

fn rebrand_arg(arg: clap::Arg) -> clap::Arg {
    let help = arg
        .get_help()
        .map(|text| fork_brand::cli_text(&text.to_string()));
    let long_help = arg
        .get_long_help()
        .map(|text| fork_brand::cli_text(&text.to_string()));
    let mut arg = arg;
    if let Some(help) = help {
        arg = arg.help(help);
    }
    if let Some(long_help) = long_help {
        arg = arg.long_help(long_help);
    }
    arg
}
