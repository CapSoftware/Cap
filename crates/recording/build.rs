fn main() {
    #[cfg(windows)]
    cc::Build::new()
        .cpp(true)
        .file("src/sources/screen_capture/process_loopback.cpp")
        .flag_if_supported("/std:c++17")
        .compile("cap_process_loopback");
}
