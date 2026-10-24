use std::io::{IsTerminal, Write};

pub fn require(yes: bool, action: &str) -> Result<(), String> {
    if yes {
        return Ok(());
    }
    if !std::io::stdin().is_terminal() {
        return Err(format!(
            "{action} requires --yes when stdin is not interactive"
        ));
    }
    eprint!("{action}? [y/N] ");
    std::io::stderr()
        .flush()
        .map_err(|error| error.to_string())?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|error| error.to_string())?;
    if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(())
    } else {
        Err("Cancelled".to_string())
    }
}
