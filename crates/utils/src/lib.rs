use std::{borrow::Cow, future::Future, path::PathBuf, sync::LazyLock};

use aho_corasick::{AhoCorasickBuilder, MatchKind};
use tracing::Instrument;

/// Wrapper around tokio::spawn that inherits the current tracing subscriber and span.
pub fn spawn_actor<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    use tracing::instrument::WithSubscriber;
    tokio::spawn(future.with_current_subscriber().in_current_span())
}

pub fn ensure_dir(path: &PathBuf) -> Result<PathBuf, std::io::Error> {
    std::fs::create_dir_all(path)?;
    Ok(path.clone())
}

/// Generates a unique filename by appending incremental numbers if conflicts exist.
///
/// This function takes a base filename and ensures it's unique by appending `(1)`, `(2)`, etc.
/// if a file with the same name already exists. It works with any file extension.
///
/// # Arguments
///
/// * `base_filename` - The desired filename (with extension)
/// * `parent_dir` - The directory where the file should be created
///
/// # Returns
///
/// Returns the unique filename that doesn't conflict with existing files.
///
/// # Example
///
/// ```rust
/// let unique_name = ensure_unique_filename("My Recording.cap", &recordings_dir);
/// // If "My Recording.cap" exists, returns "My Recording (1).cap"
/// // If that exists too, returns "My Recording (2).cap", etc.
///
/// let unique_name = ensure_unique_filename("document.pdf", &documents_dir);
/// // If "document.pdf" exists, returns "document (1).pdf"
/// ```
pub fn ensure_unique_filename(
    base_filename: &str,
    parent_dir: &std::path::Path,
) -> Result<String, String> {
    let initial_path = parent_dir.join(base_filename);

    if !initial_path.exists() {
        println!("Ensure unique filename: is free!");
        return Ok(base_filename.to_string());
    }

    let path = std::path::Path::new(base_filename);
    let (name_without_ext, extension) = if let Some(ext) = path.extension() {
        let name_without_ext = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(base_filename);
        let extension = format!(".{}", ext.to_string_lossy());
        (name_without_ext, extension)
    } else {
        (base_filename, String::new())
    };

    let mut counter = 1;

    loop {
        let numbered_filename = if extension.is_empty() {
            format!("{} ({})", name_without_ext, counter)
        } else {
            format!("{} ({}){}", name_without_ext, counter, &extension)
        };

        let test_path = parent_dir.join(&numbered_filename);

        println!("Ensure unique filename: test path count \"{counter}\"");

        if !test_path.exists() {
            println!(
                "Ensure unique filename: Found free! \"{}\"",
                &test_path.display()
            );
            return Ok(numbered_filename);
        }

        counter += 1;

        // prevent infinite loop
        if counter > 1000 {
            return Err(
                "Too many filename conflicts, unable to create unique filename".to_string(),
            );
        }
    }
}

/// Converts user-friendly moment template format strings to chrono format strings.
///
/// This function translates common template format patterns to chrono format specifiers,
/// allowing users to write intuitive date/time formats that get converted to chrono's format.
///
/// # Supported Format Patterns
///
/// ## Year
/// - `YYYY` → `%Y` - Year with century (e.g., 2025)
/// - `YY` → `%y` - Year without century (e.g., 25)
///
/// ## Month
/// - `MMMM` → `%B` - Full month name (e.g., January)
/// - `MMM` → `%b` - Abbreviated month name (e.g., Jan)
/// - `MM` → `%m` - Month as zero-padded number (01-12)
/// - `M` → `%-m` - Month as number (1-12, no padding)
///
/// ## Day
/// - `DDDD` → `%A` - Full weekday name (e.g., Monday)
/// - `DDD` → `%a` - Abbreviated weekday name (e.g., Mon)
/// - `DD` → `%d` - Day of month as zero-padded number (01-31)
/// - `D` → `%-d` - Day of month as number (1-31, no padding)
///
/// ## Hour
/// - `HH` → `%H` - Hour (24-hour) as zero-padded number (00-23)
/// - `H` → `%-H` - Hour (24-hour) as number (0-23, no padding)
/// - `hh` → `%I` - Hour (12-hour) as zero-padded number (01-12)
/// - `h` → `%-I` - Hour (12-hour) as number (1-12, no padding)
///
/// ## Minute
/// - `mm` → `%M` - Minute as zero-padded number (00-59)
/// - `m` → `%-M` - Minute as number (0-59, no padding)
///
/// ## Second
/// - `ss` → `%S` - Second as zero-padded number (00-59)
/// - `s` → `%-S` - Second as number (0-59, no padding)
///
/// ## AM/PM
/// - `A` → `%p` - AM/PM (uppercase)
/// - `a` → `%P` - am/pm (lowercase)
///
/// ## Examples
///
/// ```
/// // Basic formats
/// YYYY-MM-DD HH:mm → %Y-%m-%d %H:%M
/// // Output: "2025-01-15 14:30"
///
/// // Full month and day names
/// MMMM DD, YYYY → %B %d, %Y
/// // Output: "January 15, 2025"
///
/// // Abbreviated names
/// DDD, MMM D, YYYY → %a, %b %-d, %Y
/// // Output: "Mon, Jan 15, 2025"
///
/// // Compact format
/// YYYYMMDD_HHmmss → %Y%m%d_%H%M%S
/// // Output: "20250115_143045"
///
/// // 12-hour format with full names
/// DDDD, MMMM DD at h:mm A → %A, %B %d at %-I:%M %p
/// // Output: "Monday, January 15 at 2:30 PM"
///
/// // ISO week date
/// YYYY-Www-D → %G-W%V-%u
/// // Output: "2025-W03-1"
/// ```
///
/// # Note
///
/// Pattern matching is case-sensitive and processes longer patterns first to avoid
/// conflicts (e.g., `MMMM` is matched before `MM`).
pub fn moment_format_to_chrono(template_format: &str) -> Cow<'_, str> {
    static AC: LazyLock<aho_corasick::AhoCorasick> = LazyLock::new(|| {
        AhoCorasickBuilder::new()
            // Use LeftmostLongest patterns to ensure overlapping shorter patterns won't also match.
            .match_kind(MatchKind::LeftmostLongest)
            .build([
                "MMMM", "MMM", "MM", "M", "DDDD", "DDD", "DD", "D", "YYYY", "YY", "HH", "H", "hh",
                "h", "mm", "m", "ss", "s", "A", "a",
            ])
            .expect("Failed to build AhoCorasick automaton")
    });

    if !AC.is_match(template_format) {
        return Cow::Borrowed(template_format);
    }

    let replacements = [
        "%B", "%b", "%m", "%-m", // Month
        "%A", "%a", "%d", "%-d", // Day
        "%Y", "%y", // Year
        "%H", "%-H", // Hour (24)
        "%I", "%-I", // Hour (12)
        "%M", "%-M", // Minute
        "%S", "%-S", // Second
        "%p", "%P", // AM/PM
    ];

    let replaced = AC
        .try_replace_all(template_format, &replacements)
        .expect("AhoCorasick replace should never fail with default configuration");

    Cow::Owned(replaced)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moment_format_to_chrono_converts_and_preserves_borrowed_when_unchanged() {
        let input = "YYYY-MM-DD HH:mm:ss A a DDDD - DD - MMMM";
        let out = moment_format_to_chrono(input);
        let expected = "%Y-%m-%d %H:%M:%S %p %P %A - %d - %B";
        assert_eq!(
            out, expected,
            "Converted format must match expected chrono format"
        );

        // Identity / borrowed case: no tokens -> should return Cow::Borrowed
        let unchanged = "--";
        let out2 = moment_format_to_chrono(unchanged);
        match out2 {
            Cow::Borrowed(s) => assert_eq!(s, unchanged),
            Cow::Owned(_) => panic!("Expected Cow::Borrowed for unchanged input"),
        }
    }
}
