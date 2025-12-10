use std::{
    borrow::Cow,
    future::Future,
    num::{NonZero, NonZeroI32},
    path::PathBuf,
    sync::LazyLock,
};

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
/// let unique_name = ensure_unique_filename("My Recording.cap", &recordings_dir,);
/// // If "My Recording.cap" exists, returns "My Recording (1).cap"
/// // If that exists too, returns "My Recording (2).cap", etc.
///
/// let unique_name = ensure_unique_filename("document.pdf", &documents_dir);
/// // If "document.pdf" exists, returns "document (1).pdf"
/// ```
#[inline]
pub fn ensure_unique_filename(
    base_filename: &str,
    parent_dir: &std::path::Path,
) -> Result<String, String> {
    const DEFAULT_MAX_ATTEMPTS: NonZero<i32> = NonZero::new(50).unwrap();
    ensure_unique_filename_with_attempts(base_filename, parent_dir, DEFAULT_MAX_ATTEMPTS)
}

pub fn ensure_unique_filename_with_attempts(
    base_filename: &str,
    parent_dir: &std::path::Path,
    attempts: NonZeroI32,
) -> Result<String, String> {
    if base_filename.contains('/') || base_filename.contains('\\') {
        return Err("Filename cannot contain path separators".to_string());
    }

    let initial_path = parent_dir.join(base_filename);

    if !initial_path.exists() {
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

    let max_attempts = attempts.get();
    let mut counter = 1;

    loop {
        let numbered_filename = if extension.is_empty() {
            format!("{name_without_ext} ({counter})")
        } else {
            format!("{name_without_ext} ({counter}){extension}")
        };

        let test_path = parent_dir.join(&numbered_filename);

        if !test_path.exists() {
            return Ok(numbered_filename);
        }

        counter += 1;

        // prevent infinite loop
        if counter > max_attempts {
            return Err(
                "Too many filename conflicts, unable to create unique filename".to_string(),
            );
        }
    }
}

/// Converts moment-style template format strings to chrono format strings.
///
/// This function translates a custom subset of date/time patterns to chrono format specifiers.
///
/// **Note**: This is NOT fully compatible with moment.js. Notably, `DDD`/`DDDD` map to
/// weekday names here, whereas in moment.js they represent day-of-year. Day-of-year and
/// ISO week tokens are not supported.
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
    use std::fs;

    // moment_format_to_chrono tests

    #[test]
    fn moment_format_converts_all_patterns() {
        let input = "YYYY-MM-DD HH:mm:ss A a DDDD - DD - MMMM";
        let out = moment_format_to_chrono(input);
        let expected = "%Y-%m-%d %H:%M:%S %p %P %A - %d - %B";
        assert_eq!(out, expected);
    }

    #[test]
    fn moment_format_handles_overlapping_patterns() {
        // MMMM should be matched before MMM, MM, M
        assert_eq!(moment_format_to_chrono("MMMM"), "%B");
        assert_eq!(moment_format_to_chrono("MMM"), "%b");
        assert_eq!(moment_format_to_chrono("MM"), "%m");
        assert_eq!(moment_format_to_chrono("M"), "%-m");

        // DDDD should be matched before DDD, DD, D
        assert_eq!(moment_format_to_chrono("DDDD"), "%A");
        assert_eq!(moment_format_to_chrono("DDD"), "%a");
        assert_eq!(moment_format_to_chrono("DD"), "%d");
        assert_eq!(moment_format_to_chrono("D"), "%-d");
    }

    #[test]
    fn moment_format_handles_adjacent_tokens() {
        // No separator between tokens
        assert_eq!(moment_format_to_chrono("YYYYMMDD"), "%Y%m%d");
        assert_eq!(moment_format_to_chrono("HHmmss"), "%H%M%S");
        assert_eq!(
            moment_format_to_chrono("DDDDMMMMYYYYHHmmss"),
            "%A%B%Y%H%M%S"
        );
    }

    #[test]
    fn moment_format_handles_12_and_24_hour() {
        assert_eq!(moment_format_to_chrono("HH:mm"), "%H:%M"); // 24-hour
        assert_eq!(moment_format_to_chrono("hh:mm A"), "%I:%M %p"); // 12-hour
        assert_eq!(moment_format_to_chrono("H"), "%-H"); // No padding
        assert_eq!(moment_format_to_chrono("h"), "%-I"); // No padding
    }

    #[test]
    fn moment_format_handles_padding_variants() {
        // Padded versions
        assert_eq!(moment_format_to_chrono("DD"), "%d");
        assert_eq!(moment_format_to_chrono("MM"), "%m");
        assert_eq!(moment_format_to_chrono("HH"), "%H");

        // Unpadded versions
        assert_eq!(moment_format_to_chrono("D"), "%-d");
        assert_eq!(moment_format_to_chrono("M"), "%-m");
        assert_eq!(moment_format_to_chrono("H"), "%-H");
    }

    #[test]
    fn moment_format_empty_string() {
        let out = moment_format_to_chrono("");
        match out {
            Cow::Borrowed(s) => assert_eq!(s, ""),
            Cow::Owned(_) => panic!("Expected Cow::Borrowed for empty string"),
        }
    }

    // ensure_unique_filename tests

    #[test]
    fn unique_filename_when_no_conflict() {
        let temp_dir = tempfile::tempdir().unwrap();
        let result = ensure_unique_filename("test.cap", temp_dir.path()).unwrap();
        assert_eq!(result, "test.cap");
    }

    #[test]
    fn unique_filename_appends_counter_on_conflict() {
        let temp_dir = tempfile::tempdir().unwrap();

        // Create existing file
        fs::write(temp_dir.path().join("test.cap"), "").unwrap();

        let result = ensure_unique_filename("test.cap", temp_dir.path()).unwrap();
        assert_eq!(result, "test (1).cap");
    }

    #[test]
    fn unique_filename_increments_counter() {
        let temp_dir = tempfile::tempdir().unwrap();

        // Create existing files
        fs::write(temp_dir.path().join("test.cap"), "").unwrap();
        fs::write(temp_dir.path().join("test (1).cap"), "").unwrap();
        fs::write(temp_dir.path().join("test (2).cap"), "").unwrap();

        let result = ensure_unique_filename("test.cap", temp_dir.path()).unwrap();
        assert_eq!(result, "test (3).cap");
    }

    #[test]
    fn unique_filename_handles_no_extension() {
        let temp_dir = tempfile::tempdir().unwrap();

        fs::write(temp_dir.path().join("README"), "").unwrap();

        let result = ensure_unique_filename("README", temp_dir.path()).unwrap();
        assert_eq!(result, "README (1)");
    }

    #[test]
    fn unique_filename_handles_multiple_dots() {
        let temp_dir = tempfile::tempdir().unwrap();

        fs::write(temp_dir.path().join("archive.tar.gz"), "").unwrap();

        let result = ensure_unique_filename("archive.tar.gz", temp_dir.path()).unwrap();
        // Only the last extension is considered
        assert_eq!(result, "archive.tar (1).gz");
    }

    #[test]
    fn unique_filename_respects_max_attempts() {
        let temp_dir = tempfile::tempdir().unwrap();

        // Create base file
        fs::write(temp_dir.path().join("test.cap"), "").unwrap();

        // Try with only 3 attempts
        let attempts = NonZero::new(3).unwrap();

        // Create conflicts for attempts 1, 2, 3
        fs::write(temp_dir.path().join("test (1).cap"), "").unwrap();
        fs::write(temp_dir.path().join("test (2).cap"), "").unwrap();
        fs::write(temp_dir.path().join("test (3).cap"), "").unwrap();

        let result = ensure_unique_filename_with_attempts("test.cap", temp_dir.path(), attempts);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Too many filename conflicts"));
    }

    #[test]
    fn unique_filename_handles_directories_as_conflicts() {
        let temp_dir = tempfile::tempdir().unwrap();

        // Create a directory with the target name
        fs::create_dir(temp_dir.path().join("test.cap")).unwrap();

        let result = ensure_unique_filename("test.cap", temp_dir.path()).unwrap();
        assert_eq!(result, "test (1).cap");
    }

    #[test]
    fn unique_filename_handles_special_characters() {
        let temp_dir = tempfile::tempdir().unwrap();

        fs::write(temp_dir.path().join("My Recording (2024).cap"), "").unwrap();

        let result = ensure_unique_filename("My Recording (2024).cap", temp_dir.path()).unwrap();
        assert_eq!(result, "My Recording (2024) (1).cap");
    }

    #[test]
    fn unique_filename_handles_spaces() {
        let temp_dir = tempfile::tempdir().unwrap();

        fs::write(temp_dir.path().join("My Project.cap"), "").unwrap();

        let result = ensure_unique_filename("My Project.cap", temp_dir.path()).unwrap();
        assert_eq!(result, "My Project (1).cap");
    }

    #[test]
    fn unique_filename_finds_gap_in_sequence() {
        let temp_dir = tempfile::tempdir().unwrap();

        // Create files with a gap in numbering
        fs::write(temp_dir.path().join("test.cap"), "").unwrap();
        fs::write(temp_dir.path().join("test (1).cap"), "").unwrap();
        // Gap: test (2).cap doesn't exist
        fs::write(temp_dir.path().join("test (3).cap"), "").unwrap();

        let result = ensure_unique_filename("test.cap", temp_dir.path()).unwrap();
        // Should find the gap at (2)
        assert_eq!(result, "test (2).cap");
    }
}
