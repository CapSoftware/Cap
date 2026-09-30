use ffmpeg::{Error, format};
use std::{ffi::CString, path::Path, ptr};

pub(super) fn create(path: &str) -> Result<format::context::Output, Error> {
    let path = CString::new(path).map_err(|_| Error::InvalidData)?;
    let mut context = ptr::null_mut();

    // DASH owns manifest I/O; opening pb here prevents Windows from replacing the manifest.
    let result = unsafe {
        ffmpeg::ffi::avformat_alloc_output_context2(
            &mut context,
            ptr::null_mut(),
            c"dash".as_ptr(),
            path.as_ptr(),
        )
    };
    if result < 0 {
        return Err(Error::from(result));
    }
    if context.is_null() {
        return Err(Error::Unknown);
    }

    Ok(unsafe { format::context::Output::wrap(context) })
}

pub(super) fn verify_final_manifest(base_path: &Path) -> std::io::Result<()> {
    let manifest = std::fs::read_to_string(base_path.join("dash_manifest.mpd"))?;
    if !manifest.contains("type=\"static\"") || !manifest.trim_end().ends_with("</MPD>") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "DASH manifest was not finalized",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dash_context_does_not_open_or_truncate_manifest() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dash_manifest.mpd");
        std::fs::write(&path, b"previous manifest").unwrap();

        let output = create(path.to_str().unwrap()).unwrap();

        assert!(output.format().flags().contains(format::Flags::NO_FILE));
        assert!(unsafe { (*output.as_ptr()).pb.is_null() });
        assert_eq!(std::fs::read(&path).unwrap(), b"previous manifest");
    }
}
