pub fn ensure_whisper_cpu_support() -> Result<(), &'static str> {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        validate_whisper_cpu_features(
            std::is_x86_feature_detected!("avx2"),
            std::is_x86_feature_detected!("fma"),
            std::is_x86_feature_detected!("f16c"),
        )
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        Ok(())
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64", test))]
fn validate_whisper_cpu_features(avx2: bool, fma: bool, f16c: bool) -> Result<(), &'static str> {
    // whisper-rs-sys 0.9.0 compiles its x86 engine with these instructions;
    // entering that native code on an older CPU raises an uncatchable SIGILL.
    if avx2 && fma && f16c {
        Ok(())
    } else {
        Err("Whisper local captions require a CPU with AVX2, FMA, and F16C support.")
    }
}

#[cfg(test)]
mod tests {
    use super::validate_whisper_cpu_features;

    #[test]
    fn unsupported_instruction_sets_are_rejected() {
        for mask in 0..7 {
            assert!(
                validate_whisper_cpu_features(mask & 1 != 0, mask & 2 != 0, mask & 4 != 0).is_err()
            );
        }
    }

    #[test]
    fn supported_instruction_set_is_accepted() {
        assert!(validate_whisper_cpu_features(true, true, true).is_ok());
    }
}
