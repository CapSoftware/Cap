pub const HESITATION_FILLERS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "eh", "hm", "hmm", "mm", "mmm",
];

pub fn normalize_word(text: &str) -> String {
    text.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
        .to_lowercase()
}

pub fn is_hesitation_filler(text: &str) -> bool {
    HESITATION_FILLERS.contains(&normalize_word(text).as_str())
}
