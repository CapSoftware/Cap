//! All `unsafe` for the X11 MIT-SHM segment lives here. The segment is marked
//! `IPC_RMID` right after the server attaches it, so the kernel frees it once
//! both sides detach, even if this process crashes.

use anyhow::{Context as _, anyhow, bail};
use std::{ptr::NonNull, sync::Arc};
use x11rb::connection::{Connection as _, RequestConnection as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{Drawable, ImageFormat};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

pub(crate) const DISABLE_SHM_ENV: &str = "CAP_X11_DISABLE_SHM";

pub(crate) fn shm_disabled_by_env() -> bool {
    std::env::var(DISABLE_SHM_ENV).is_ok_and(|value| is_truthy(&value))
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub(crate) fn image_stride(width: u16, bits_per_pixel: u8, scanline_pad: u8) -> Option<usize> {
    if bits_per_pixel == 0 || scanline_pad == 0 || scanline_pad % 8 != 0 {
        return None;
    }
    let row_bits = usize::from(width).checked_mul(usize::from(bits_per_pixel))?;
    let pad_bytes = usize::from(scanline_pad / 8);
    row_bits.div_ceil(8).checked_next_multiple_of(pad_bytes)
}

pub(crate) fn image_size(
    width: u16,
    height: u16,
    bits_per_pixel: u8,
    scanline_pad: u8,
) -> Option<usize> {
    image_stride(width, bits_per_pixel, scanline_pad)?.checked_mul(usize::from(height))
}

pub(crate) fn query_shm_support(conn: &RustConnection) -> anyhow::Result<()> {
    if conn
        .extension_information(shm::X11_EXTENSION_NAME)
        .context("query MIT-SHM extension")?
        .is_none()
    {
        bail!("MIT-SHM extension is not available");
    }
    let version = conn
        .shm_query_version()
        .context("request MIT-SHM version")?
        .reply()
        .context("read MIT-SHM version")?;
    if (version.major_version, version.minor_version) < (1, 1) {
        bail!(
            "MIT-SHM {}.{} is too old",
            version.major_version,
            version.minor_version
        );
    }
    Ok(())
}

struct SysvMapping {
    shmid: i32,
    addr: NonNull<u8>,
    size: usize,
    removed: bool,
}

// SAFETY: the mapping is exclusively owned by this value and SysV attachments
// are process-wide, so it may be used and dropped from any thread.
unsafe impl Send for SysvMapping {}

impl SysvMapping {
    fn new(size: usize) -> anyhow::Result<Self> {
        if size == 0 {
            bail!("shared-memory segment size must be non-zero");
        }
        // SAFETY: shmget has no memory-safety preconditions; a negative return
        // is handled as an error below.
        let shmid = unsafe { libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o600) };
        if shmid < 0 {
            return Err(std::io::Error::last_os_error()).context("shmget");
        }
        // SAFETY: `shmid` is a segment we just created; a null address lets
        // the kernel pick the mapping location. Failure returns `(void*)-1`.
        let raw = unsafe { libc::shmat(shmid, std::ptr::null(), 0) };
        if raw as isize == -1 {
            let error = std::io::Error::last_os_error();
            // SAFETY: removing the unattached segment we created; no pointer
            // is involved.
            unsafe { libc::shmctl(shmid, libc::IPC_RMID, std::ptr::null_mut()) };
            return Err(error).context("shmat");
        }
        let addr = NonNull::new(raw.cast::<u8>()).ok_or_else(|| anyhow!("shmat returned null"))?;
        Ok(Self {
            shmid,
            addr,
            size,
            removed: false,
        })
    }

    // Destruction is deferred until every attachment (ours and the X
    // server's) is gone, so the segment cannot outlive a crash of this process.
    fn mark_removed(&mut self) -> anyhow::Result<()> {
        if self.removed {
            return Ok(());
        }
        // SAFETY: `shmid` refers to the segment we own; IPC_RMID takes no buffer.
        if unsafe { libc::shmctl(self.shmid, libc::IPC_RMID, std::ptr::null_mut()) } != 0 {
            return Err(std::io::Error::last_os_error()).context("shmctl(IPC_RMID)");
        }
        self.removed = true;
        Ok(())
    }

    fn bytes(&self) -> &[u8] {
        // SAFETY: `addr` points to a live mapping of exactly `size` bytes that
        // stays attached until `self` is dropped. The X server only writes to
        // it while servicing a ShmGetImage request, and callers only read
        // after that request's reply has arrived, so no write overlaps this
        // borrow.
        unsafe { std::slice::from_raw_parts(self.addr.as_ptr(), self.size) }
    }
}

impl Drop for SysvMapping {
    fn drop(&mut self) {
        if let Err(error) = self.mark_removed() {
            tracing::warn!(error = %error, shmid = self.shmid, "Failed to remove X11 shared memory");
        }
        // SAFETY: `addr` came from a successful shmat and is detached exactly
        // once, here; no borrows of `bytes()` can outlive `self`.
        if unsafe { libc::shmdt(self.addr.as_ptr().cast()) } != 0 {
            tracing::warn!(
                error = %std::io::Error::last_os_error(),
                shmid = self.shmid,
                "Failed to detach X11 shared memory"
            );
        }
    }
}

// `Drop` detaches from the server and waits for it to confirm before the
// `mapping` field drops and unmaps locally.
pub(crate) struct ShmSegment {
    conn: Arc<RustConnection>,
    seg: shm::Seg,
    mapping: SysvMapping,
}

impl ShmSegment {
    pub(crate) fn new(conn: &Arc<RustConnection>, size: usize) -> anyhow::Result<Self> {
        let mapping = SysvMapping::new(size)?;
        let shmid =
            u32::try_from(mapping.shmid).map_err(|_| anyhow!("invalid shmid {}", mapping.shmid))?;
        let seg = conn.generate_id().context("allocate MIT-SHM segment id")?;
        conn.shm_attach(seg, shmid, false)
            .context("request MIT-SHM attach")?
            .check()
            .context("X server could not attach shared memory")?;
        let mut segment = Self {
            conn: Arc::clone(conn),
            seg,
            mapping,
        };
        segment.mapping.mark_removed()?;
        Ok(segment)
    }

    pub(crate) fn len(&self) -> usize {
        self.mapping.size
    }

    pub(crate) fn get_image(
        &mut self,
        drawable: Drawable,
        x: i16,
        y: i16,
        width: u16,
        height: u16,
    ) -> anyhow::Result<&[u8]> {
        let reply = self
            .conn
            .shm_get_image(
                drawable,
                x,
                y,
                width,
                height,
                u32::MAX,
                ImageFormat::Z_PIXMAP.into(),
                self.seg,
                0,
            )
            .context("request X11 shared-memory image")?
            .reply()
            .context("read X11 shared-memory image")?;
        let written = usize::try_from(reply.size).unwrap_or(usize::MAX);
        if written > self.mapping.size {
            bail!(
                "X11 shared-memory image of {written} bytes overflows a {} byte segment",
                self.mapping.size
            );
        }
        Ok(&self.mapping.bytes()[..written])
    }
}

impl Drop for ShmSegment {
    fn drop(&mut self) {
        if let Ok(cookie) = self.conn.shm_detach(self.seg) {
            cookie.ignore_error();
        }
        // The server may still be mapping the segment while the detach request
        // is in flight; a round trip guarantees it has let go before shmdt.
        if let Err(error) = self.conn.sync() {
            tracing::debug!(error = %error, "X11 sync after MIT-SHM detach failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment_exists(shmid: i32) -> bool {
        std::fs::read_to_string("/proc/sysvipc/shm")
            .unwrap()
            .lines()
            .skip(1)
            .any(|line| line.split_whitespace().nth(1) == Some(&shmid.to_string()))
    }

    #[test]
    fn stride_pads_rows_to_the_scanline_unit() {
        assert_eq!(image_stride(1920, 32, 32), Some(7680));
        assert_eq!(image_stride(1, 32, 32), Some(4));
        assert_eq!(image_stride(3, 24, 32), Some(12));
        assert_eq!(image_stride(5, 16, 32), Some(12));
        assert_eq!(image_stride(5, 8, 32), Some(8));
        assert_eq!(image_stride(5, 8, 8), Some(5));
        assert_eq!(image_stride(0, 32, 32), Some(0));
    }

    #[test]
    fn stride_rejects_invalid_formats() {
        assert_eq!(image_stride(10, 0, 32), None);
        assert_eq!(image_stride(10, 32, 0), None);
        assert_eq!(image_stride(10, 32, 12), None);
    }

    #[test]
    fn size_covers_every_row() {
        assert_eq!(image_size(1920, 1080, 32, 32), Some(1920 * 1080 * 4));
        assert_eq!(image_size(3840, 2160, 32, 32), Some(3840 * 2160 * 4));
        assert_eq!(image_size(3, 7, 24, 32), Some(12 * 7));
        assert_eq!(
            image_size(u16::MAX, u16::MAX, 32, 32),
            Some(65535 * 65535 * 4)
        );
    }

    #[test]
    fn mapping_is_readable_and_freed_on_drop() {
        let mapping = SysvMapping::new(4096).unwrap();
        let shmid = mapping.shmid;
        assert!(segment_exists(shmid));
        assert_eq!(mapping.bytes().len(), 4096);
        assert!(mapping.bytes().iter().all(|byte| *byte == 0));
        drop(mapping);
        assert!(!segment_exists(shmid));
    }

    #[test]
    fn removed_mapping_stays_usable_until_dropped() {
        let mut mapping = SysvMapping::new(8192).unwrap();
        let shmid = mapping.shmid;
        mapping.mark_removed().unwrap();
        mapping.mark_removed().unwrap();
        assert_eq!(mapping.bytes().len(), 8192);
        drop(mapping);
        assert!(!segment_exists(shmid));
    }

    #[test]
    fn zero_sized_mapping_is_rejected() {
        assert!(SysvMapping::new(0).is_err());
    }

    #[test]
    fn env_opt_out_accepts_common_truthy_values() {
        for (value, expected) in [
            ("1", true),
            ("true", true),
            (" YES ", true),
            ("on", true),
            ("0", false),
            ("", false),
            ("no", false),
        ] {
            assert_eq!(is_truthy(value), expected, "{value:?}");
        }
    }
}
