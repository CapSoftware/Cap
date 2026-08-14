pub fn value() -> serde_json::Value {
    serde_json::to_value(&cap_flags::FLAGS).unwrap_or_default()
}
