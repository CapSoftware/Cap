use std::env;

fn build() -> cc::Build {
    let mut build = cc::Build::new();
    build
        .include("vendor/include")
        .include("vendor/src")
        .define("RNNOISE_BUILD", None)
        .define("USE_WEIGHTS_FILE", None)
        .define("_USE_MATH_DEFINES", None)
        .opt_level(3)
        .warnings(false);
    build
}

fn main() {
    println!("cargo:rerun-if-changed=vendor");
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let target = env::var("CARGO_CFG_TARGET_ENV").unwrap();
    let is_x86 = matches!(arch.as_str(), "x86_64" | "x86");
    let mut core = build();
    for source in [
        "denoise",
        "rnn",
        "pitch",
        "kiss_fft",
        "celt_lpc",
        "nnet",
        "nnet_default",
        "parse_lpcnet_weights",
        "rnnoise_data",
        "rnnoise_tables",
    ] {
        core.file(format!("vendor/src/{source}.c"));
    }
    if is_x86 {
        core.define("RNN_ENABLE_X86_RTCD", None)
            .file("vendor/src/x86/x86cpu.c")
            .file("vendor/src/x86/x86_dnn_map.c");
        if target != "msvc" {
            core.define("CPU_INFO_BY_C", None);
        }
    }
    // GNU ld needs the core archive before the SIMD archives it references.
    core.compile("cap_rnnoise");
    if is_x86 {
        for (name, flag) in [("sse4_1", "-msse4.1"), ("avx2", "-mavx2")] {
            let mut vector = build();
            vector.file(format!("vendor/src/x86/nnet_{name}.c"));
            if target == "msvc" {
                vector
                    .define("OPUS_X86_MAY_HAVE_SSE", None)
                    .define("OPUS_X86_MAY_HAVE_SSE2", None)
                    .define("OPUS_X86_MAY_HAVE_SSE4_1", None);
                if name == "avx2" {
                    vector.flag("/arch:AVX2");
                }
            } else {
                vector.flag(flag);
                if name == "avx2" {
                    vector.flag("-mfma");
                }
            }
            vector.compile(&format!("cap_rnnoise_{name}"));
        }
    }
}
