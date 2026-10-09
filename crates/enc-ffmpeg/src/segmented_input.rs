use std::{
    ffi::{c_int, c_void},
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    ptr::{self, NonNull},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{RelocatableReader, RelocatableSource, remux::RemuxError};

struct InterruptState {
    callback: Arc<dyn Fn() -> bool + Send + Sync>,
    cancelled: AtomicBool,
}

impl InterruptState {
    fn is_cancelled(&self) -> bool {
        if self.cancelled.load(Ordering::Relaxed) {
            return true;
        }
        let cancelled = catch_unwind(AssertUnwindSafe(|| (self.callback)())).unwrap_or(true);
        if cancelled {
            self.cancelled.store(true, Ordering::Relaxed);
        }
        cancelled
    }
}

unsafe extern "C" fn interrupt_callback(opaque: *mut c_void) -> c_int {
    if opaque.is_null() {
        return 1;
    }
    let interrupt = unsafe { &*opaque.cast::<InterruptState>() };
    c_int::from(interrupt.is_cancelled())
}

struct Part {
    path: PathBuf,
    start: u64,
    end: u64,
}

struct OpenPart {
    index: usize,
    file: File,
    position: u64,
}

struct ConcatenatedFiles {
    parts: Vec<Part>,
    length: u64,
    position: u64,
    current: Option<OpenPart>,
    failure: Option<io::Error>,
    managed: Option<Vec<RelocatableReader>>,
    managed_current: Option<usize>,
    interrupt: Option<Arc<InterruptState>>,
}

impl ConcatenatedFiles {
    fn new<'a>(paths: impl IntoIterator<Item = &'a Path>) -> io::Result<Self> {
        let mut parts = Vec::new();
        let mut length = 0_u64;
        for path in paths {
            let metadata = path.metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Segmented input must contain regular files",
                ));
            }
            let end = length
                .checked_add(metadata.len())
                .filter(|length| *length <= i64::MAX as u64)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "Segmented input is too large")
                })?;
            parts.push(Part {
                path: path.to_path_buf(),
                start: length,
                end,
            });
            length = end;
        }
        Ok(Self {
            parts,
            length,
            position: 0,
            current: None,
            failure: None,
            managed: None,
            managed_current: None,
            interrupt: None,
        })
    }

    fn new_relocatable<'a>(
        source: &RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
        interrupt: Option<Arc<InterruptState>>,
    ) -> io::Result<Self> {
        let mut reader = Self::new([])?;
        reader.interrupt = interrupt;
        let mut managed = Vec::new();
        let mut paths = paths.into_iter();
        loop {
            if reader.check_interrupt() {
                return Err(reader.failure.take().unwrap());
            }
            let batch: Vec<_> = paths.by_ref().take(64).map(Path::to_path_buf).collect();
            if batch.is_empty() {
                break;
            }
            if reader.check_interrupt() {
                return Err(reader.failure.take().unwrap());
            }
            let registered = source.readers(&batch)?;
            if reader.check_interrupt() {
                return Err(reader.failure.take().unwrap());
            }
            for (path, part) in batch.into_iter().zip(registered) {
                let end = reader
                    .length
                    .checked_add(part.len())
                    .filter(|length| *length <= i64::MAX as u64)
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidInput, "Segmented input is too large")
                    })?;
                reader.parts.push(Part {
                    path,
                    start: reader.length,
                    end,
                });
                managed.push(part);
                reader.length = end;
            }
        }
        reader.managed = Some(managed);
        Ok(reader)
    }

    fn check_interrupt(&mut self) -> bool {
        if self
            .interrupt
            .as_ref()
            .is_some_and(|interrupt| interrupt.is_cancelled())
        {
            if self.failure.is_none() {
                self.failure = Some(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Segmented input cancelled",
                ));
            }
            true
        } else {
            false
        }
    }

    fn read_managed(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let index = self.parts.partition_point(|part| part.end <= self.position);
        let part = self.parts.get(index).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "Missing segmented input range")
        })?;
        let readers = self
            .managed
            .as_mut()
            .ok_or_else(|| io::Error::other("Missing managed sources"))?;
        if self.managed_current != Some(index) {
            if let Some(previous) = self.managed_current {
                readers[previous].close()?;
            }
            self.managed_current = Some(index);
        }
        let reader = &mut readers[index];
        reader.seek(SeekFrom::Start(self.position - part.start))?;
        let count = reader.read(buffer)?;
        self.position += count as u64;
        Ok(count)
    }

    fn record_failure(&mut self, error: io::Error) -> c_int {
        if self.failure.is_none() {
            self.failure = Some(error);
        }
        ffmpeg::ffi::AVERROR(ffmpeg::ffi::EIO)
    }
}

impl Read for ConcatenatedFiles {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.position >= self.length {
            return Ok(0);
        }
        if self.managed.is_some() {
            return self.read_managed(buffer);
        }
        let index = self.parts.partition_point(|part| part.end <= self.position);
        let part = self.parts.get(index).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "Missing segmented input range")
        })?;
        let length = part.end - part.start;
        if self.current.as_ref().is_none_or(|open| open.index != index) {
            let file = File::open(&part.path)?;
            if file.metadata()?.len() != length {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Segmented input length changed",
                ));
            }
            self.current = Some(OpenPart {
                index,
                file,
                position: 0,
            });
        }
        let current = self.current.as_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "Missing segmented input file")
        })?;
        let position = self.position - part.start;
        if current.position != position {
            current.file.seek(SeekFrom::Start(position))?;
            current.position = position;
        }
        let limit = (part.end - self.position).min(buffer.len() as u64) as usize;
        let count = current.file.read(&mut buffer[..limit])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Segmented input was truncated",
            ));
        }
        self.position += count as u64;
        current.position += count as u64;
        if self.position == part.end && current.file.metadata()?.len() != length {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Segmented input length changed",
            ));
        }
        Ok(count)
    }
}

impl Seek for ConcatenatedFiles {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(position) => i128::from(position),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.length) + i128::from(offset),
        };
        if !(0..=i128::from(i64::MAX)).contains(&position) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid segmented input seek",
            ));
        }
        self.position = position as u64;
        Ok(self.position)
    }
}

unsafe extern "C" fn read_packet(opaque: *mut c_void, buffer: *mut u8, size: c_int) -> c_int {
    if opaque.is_null() || buffer.is_null() || size <= 0 {
        return ffmpeg::ffi::AVERROR(ffmpeg::ffi::EINVAL);
    }
    let reader = unsafe { &mut *opaque.cast::<ConcatenatedFiles>() };
    if reader.check_interrupt() {
        return ffmpeg::ffi::AVERROR_EXIT;
    }
    let buffer = unsafe { std::slice::from_raw_parts_mut(buffer, size as usize) };
    match catch_unwind(AssertUnwindSafe(|| reader.read(buffer))) {
        Ok(Ok(0)) => ffmpeg::ffi::AVERROR_EOF,
        Ok(Ok(count)) => count as c_int,
        Ok(Err(error)) => reader.record_failure(error),
        Err(_) => reader.record_failure(io::Error::other("Segmented input read panicked")),
    }
}

unsafe extern "C" fn seek(opaque: *mut c_void, offset: i64, whence: c_int) -> i64 {
    if opaque.is_null() {
        return i64::from(ffmpeg::ffi::AVERROR(ffmpeg::ffi::EINVAL));
    }
    let reader = unsafe { &mut *opaque.cast::<ConcatenatedFiles>() };
    if reader.check_interrupt() {
        return i64::from(ffmpeg::ffi::AVERROR_EXIT);
    }
    let from = match whence & !ffmpeg::ffi::AVSEEK_FORCE {
        ffmpeg::ffi::AVSEEK_SIZE => return reader.length as i64,
        ffmpeg::ffi::SEEK_SET if offset >= 0 => SeekFrom::Start(offset as u64),
        ffmpeg::ffi::SEEK_CUR => SeekFrom::Current(offset),
        ffmpeg::ffi::SEEK_END => SeekFrom::End(offset),
        _ => return i64::from(ffmpeg::ffi::AVERROR(ffmpeg::ffi::EINVAL)),
    };
    match catch_unwind(AssertUnwindSafe(|| reader.seek(from))) {
        Ok(Ok(position)) => position as i64,
        Ok(Err(_)) => i64::from(ffmpeg::ffi::AVERROR(ffmpeg::ffi::EINVAL)),
        Err(_) => {
            i64::from(reader.record_failure(io::Error::other("Segmented input seek panicked")))
        }
    }
}

struct IoContext {
    context: NonNull<ffmpeg::ffi::AVIOContext>,
    reader: Box<ConcatenatedFiles>,
}

// AVIO and its boxed callback state are exclusively owned and never accessed concurrently.
// Moving this owner preserves every allocation and keeps Send callback state alive until close.
unsafe impl Send for IoContext {}

impl IoContext {
    fn new(reader: ConcatenatedFiles) -> Result<Self, RemuxError> {
        fn require_send<T: Send>() {}
        require_send::<ConcatenatedFiles>();
        let mut reader = Box::new(reader);
        let buffer_size = 64 * 1024;
        let buffer = unsafe { ffmpeg::ffi::av_malloc(buffer_size) }.cast::<u8>();
        if buffer.is_null() {
            return Err(io::Error::from(io::ErrorKind::OutOfMemory).into());
        }
        let context = unsafe {
            ffmpeg::ffi::avio_alloc_context(
                buffer,
                buffer_size as c_int,
                0,
                ptr::from_mut(reader.as_mut()).cast(),
                Some(read_packet),
                None,
                Some(seek),
            )
        };
        let Some(context) = NonNull::new(context) else {
            unsafe { ffmpeg::ffi::av_free(buffer.cast()) };
            return Err(io::Error::from(io::ErrorKind::OutOfMemory).into());
        };
        Ok(Self { context, reader })
    }
}

impl Drop for IoContext {
    fn drop(&mut self) {
        let mut context = self.context.as_ptr();
        unsafe {
            // FFmpeg may replace the buffer; custom I/O owns the final pointer separately.
            ffmpeg::ffi::av_free((*context).buffer.cast());
            (*context).buffer = ptr::null_mut();
            ffmpeg::ffi::avio_context_free(&mut context);
        }
    }
}

pub struct SegmentedInput {
    // Close the format input before freeing its custom I/O buffer and callback state.
    input: ffmpeg::format::context::Input,
    io: IoContext,
}

impl SegmentedInput {
    pub fn open<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Result<Self, RemuxError> {
        Self::open_reader(ConcatenatedFiles::new(paths)?)
    }

    pub fn open_relocatable<'a>(
        source: &RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> Result<Self, RemuxError> {
        Self::open_reader(ConcatenatedFiles::new_relocatable(source, paths, None)?)
    }

    pub fn open_relocatable_interruptible<'a>(
        source: &RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
        interrupt: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self, RemuxError> {
        let interrupt = Arc::new(InterruptState {
            callback: interrupt,
            cancelled: AtomicBool::new(false),
        });
        Self::open_reader(ConcatenatedFiles::new_relocatable(
            source,
            paths,
            Some(interrupt),
        )?)
    }

    fn open_reader(reader: ConcatenatedFiles) -> Result<Self, RemuxError> {
        let mut io = IoContext::new(reader)?;
        if io.reader.check_interrupt() {
            return Err(io.reader.failure.take().unwrap().into());
        }
        let mut context = unsafe { ffmpeg::ffi::avformat_alloc_context() };
        if context.is_null() {
            return Err(io::Error::from(io::ErrorKind::OutOfMemory).into());
        }
        let opened = unsafe {
            if let Some(interrupt) = &io.reader.interrupt {
                (*context).interrupt_callback = ffmpeg::ffi::AVIOInterruptCB {
                    callback: Some(interrupt_callback),
                    opaque: Arc::as_ptr(interrupt).cast_mut().cast(),
                };
            }
            (*context).pb = io.context.as_ptr();
            (*context).flags |= ffmpeg::ffi::AVFMT_FLAG_CUSTOM_IO;
            ffmpeg::ffi::avformat_open_input(
                &mut context,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
            )
        };
        let interrupted = io.reader.check_interrupt();
        if opened < 0 || interrupted {
            unsafe { ffmpeg::ffi::avformat_close_input(&mut context) };
            return Err(match io.reader.failure.take() {
                Some(error) => error.into(),
                None => ffmpeg::Error::from(opened).into(),
            });
        }
        let input = unsafe { ffmpeg::format::context::Input::wrap(context) };
        let mut opened = Self { input, io };
        let found = unsafe {
            ffmpeg::ffi::avformat_find_stream_info(opened.input.as_mut_ptr(), ptr::null_mut())
        };
        opened.io.reader.check_interrupt();
        if let Some(error) = opened.io.reader.failure.take() {
            return Err(error.into());
        }
        if found < 0 {
            return Err(ffmpeg::Error::from(found).into());
        }
        Ok(opened)
    }

    pub fn input(&self) -> &ffmpeg::format::context::Input {
        &self.input
    }

    pub fn io_error(&self) -> Option<&io::Error> {
        self.io.reader.failure.as_ref()
    }

    pub fn read_packet(&mut self, packet: &mut ffmpeg::Packet) -> Result<(), ffmpeg::Error> {
        if self.io.reader.check_interrupt() {
            return Err(ffmpeg::Error::Exit);
        }
        if self.io.reader.failure.is_some() {
            return Err(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::EIO,
            });
        }
        let result = packet.read(&mut self.input);
        if self.io.reader.check_interrupt() {
            return Err(ffmpeg::Error::Exit);
        }
        if self.io.reader.failure.is_some() {
            return Err(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::EIO,
            });
        }
        result
    }

    pub fn seek(&mut self, timestamp: i64) -> Result<(), ffmpeg::Error> {
        if self.io.reader.check_interrupt() {
            return Err(ffmpeg::Error::Exit);
        }
        if self.io.reader.failure.is_some() {
            return Err(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::EIO,
            });
        }
        let result = self.input.seek(timestamp, ..timestamp);
        if self.io.reader.check_interrupt() {
            return Err(ffmpeg::Error::Exit);
        }
        if self.io.reader.failure.is_some() {
            return Err(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::EIO,
            });
        }
        result
    }
}

pub(crate) fn with_input<'a, T>(
    paths: impl IntoIterator<Item = &'a Path>,
    operation: impl FnOnce(&mut ffmpeg::format::context::Input) -> Result<T, RemuxError>,
) -> Result<T, RemuxError> {
    let mut input = SegmentedInput::open(paths)?;
    let result = operation(&mut input.input);
    match input.io.reader.failure.take() {
        Some(error) => Err(error.into()),
        None => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave_parts(directory: &Path) -> Vec<PathBuf> {
        let data_length = 48_000_u32 * 2 * 20;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(data_length + 36).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&48_000_u32.to_le_bytes());
        bytes.extend_from_slice(&96_000_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_length.to_le_bytes());
        for index in 0..data_length / 2 {
            bytes.extend_from_slice(&(index as i16).to_le_bytes());
        }
        bytes
            .chunks(16_384)
            .enumerate()
            .map(|(index, data)| {
                let path = directory.join(format!("part-{index:03}.bin"));
                std::fs::write(&path, data).unwrap();
                path
            })
            .collect()
    }

    #[test]
    fn owned_input_can_move_seek_and_read_until_eof() {
        let directory = tempfile::tempdir().unwrap();
        let paths = wave_parts(directory.path());
        let input = SegmentedInput::open(paths.iter().map(PathBuf::as_path)).unwrap();
        let mut input = Box::new(input);
        assert_eq!(input.input().streams().count(), 1);
        for timestamp in [0, 10_000_000, 1_000_000, 19_000_000] {
            input.seek(timestamp).unwrap();
            let mut packet = ffmpeg::Packet::empty();
            input.read_packet(&mut packet).unwrap();
            assert!(packet.size() > 0);
        }
        loop {
            let mut packet = ffmpeg::Packet::empty();
            match input.read_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(error) => panic!("Unexpected packet read failure: {error}"),
            }
        }
        assert!(input.io.reader.failure.is_none());
    }

    #[test]
    fn missing_later_part_is_a_persistent_error_even_after_seek() {
        let directory = tempfile::tempdir().unwrap();
        let paths = wave_parts(directory.path());
        let mut input = SegmentedInput::open(paths.iter().map(PathBuf::as_path)).unwrap();
        for path in paths.iter().skip(1) {
            std::fs::remove_file(path).unwrap();
        }
        let mut failed = false;
        for _ in 0..1_000 {
            let mut packet = ffmpeg::Packet::empty();
            match input.read_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EIO => {
                    failed = true;
                    break;
                }
                Err(error) => panic!("Input failure was misreported: {error}"),
            }
        }
        assert!(failed, "Missing data must fail before clean EOF");
        let mut packet = ffmpeg::Packet::empty();
        assert_eq!(
            input.read_packet(&mut packet),
            Err(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::EIO
            })
        );
        assert_eq!(
            input.seek(0),
            Err(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::EIO
            })
        );
    }

    #[test]
    fn concatenated_reads_and_seeks_match_flat_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        let mut bytes = Vec::new();
        for (index, size) in [0, 31, 131_071, 1, 0, 63, 8192].into_iter().enumerate() {
            let data: Vec<_> = (0..size)
                .map(|offset| (offset * 13 + index) as u8)
                .collect();
            let path = directory
                .path()
                .join(format!("fragment '{index}' café.bin"));
            std::fs::write(&path, &data).unwrap();
            paths.push(path);
            bytes.extend(data);
        }
        let mut reader = ConcatenatedFiles::new(paths.iter().map(PathBuf::as_path)).unwrap();
        let mut actual = Vec::new();
        reader.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, bytes);
        let mut reference = io::Cursor::new(&bytes);
        reader.rewind().unwrap();
        let mut state = 57_u64;
        for index in 0..1000 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            let from = match index % 3 {
                0 => SeekFrom::Start(state % (bytes.len() as u64 + 17)),
                1 => SeekFrom::Current((state % 513) as i64 - 256),
                _ => SeekFrom::End(17 - (state % (bytes.len() as u64 + 1)) as i64),
            };
            let actual = reader.seek(from);
            let expected = reference.seek(from);
            assert_eq!(actual.is_ok(), expected.is_ok());
            if let (Ok(actual), Ok(expected)) = (actual, expected) {
                assert_eq!(actual, expected);
            }
            let count = state % 4097;
            let mut actual = Vec::new();
            let mut expected = Vec::new();
            reader
                .by_ref()
                .take(count)
                .read_to_end(&mut actual)
                .unwrap();
            reference
                .by_ref()
                .take(count)
                .read_to_end(&mut expected)
                .unwrap();
            assert_eq!(actual, expected);
            assert_eq!(reader.position, reference.position());
        }
    }

    #[test]
    fn changed_fragment_lengths_and_missing_files_are_errors() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fragment.bin");
        for changed_length in [3, 32] {
            std::fs::write(&path, [0x35; 16]).unwrap();
            let mut reader = ConcatenatedFiles::new([path.as_path()]).unwrap();
            let mut prefix = [0; 2];
            reader.read_exact(&mut prefix).unwrap();
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(changed_length)
                .unwrap();
            assert!(reader.read_to_end(&mut Vec::new()).is_err());
        }
        std::fs::write(&path, [0x35; 16]).unwrap();
        let mut reader = ConcatenatedFiles::new([path.as_path()]).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            reader.read(&mut [0; 1]).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn seek_handles_large_offsets_and_rejects_overflow_without_moving() {
        let mut reader = ConcatenatedFiles::new([]).unwrap();
        assert_eq!(reader.seek(SeekFrom::Start(1 << 40)).unwrap(), 1 << 40);
        assert_eq!(reader.seek(SeekFrom::Current(17)).unwrap(), (1 << 40) + 17);
        assert!(reader.seek(SeekFrom::Start(u64::MAX)).is_err());
        assert_eq!(reader.position, (1 << 40) + 17);
        assert!(reader.seek(SeekFrom::Current(i64::MIN)).is_err());
        assert_eq!(reader.position, (1 << 40) + 17);
        assert_eq!(reader.read(&mut [0; 4]).unwrap(), 0);
        reader.seek(SeekFrom::Start(i64::MAX as u64)).unwrap();
        assert!(reader.seek(SeekFrom::Current(1)).is_err());
        assert_eq!(reader.position, i64::MAX as u64);
        assert_eq!(reader.seek(SeekFrom::End(0)).unwrap(), 0);
    }

    #[test]
    fn io_callbacks_distinguish_eof_and_preserve_read_failures() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fragment.bin");
        std::fs::write(&path, [0x35; 16]).unwrap();
        let mut reader = ConcatenatedFiles::new([path.as_path()]).unwrap();
        let opaque = ptr::from_mut(&mut reader).cast();
        let mut buffer = [0; 32];
        unsafe {
            assert_eq!(seek(opaque, 0, ffmpeg::ffi::AVSEEK_SIZE), 16);
            assert_eq!(
                seek(opaque, 0, ffmpeg::ffi::SEEK_SET | ffmpeg::ffi::AVSEEK_FORCE),
                0
            );
            assert_eq!(read_packet(opaque, buffer.as_mut_ptr(), 32), 16);
            assert_eq!(
                read_packet(opaque, buffer.as_mut_ptr(), 32),
                ffmpeg::ffi::AVERROR_EOF
            );
        }
        assert!(reader.failure.is_none());
        reader.current = None;
        reader.rewind().unwrap();
        std::fs::remove_file(&path).unwrap();
        unsafe {
            assert_eq!(
                read_packet(opaque, buffer.as_mut_ptr(), 32),
                ffmpeg::ffi::AVERROR(ffmpeg::ffi::EIO)
            );
            assert_eq!(seek(opaque, 0, ffmpeg::ffi::SEEK_END), 16);
            assert_eq!(
                read_packet(opaque, buffer.as_mut_ptr(), 32),
                ffmpeg::ffi::AVERROR_EOF
            );
        }
        assert_eq!(reader.failure.unwrap().kind(), io::ErrorKind::NotFound);
    }
    fn relative_parts(paths: &[PathBuf]) -> Vec<PathBuf> {
        paths
            .iter()
            .map(|path| PathBuf::from(path.file_name().unwrap()))
            .collect()
    }

    #[derive(Debug, PartialEq, Eq)]
    struct PacketSnapshot {
        stream: usize,
        pts: Option<i64>,
        dts: Option<i64>,
        duration: i64,
        flags: i32,
        bytes: Vec<u8>,
    }

    fn next_snapshot(input: &mut SegmentedInput) -> Option<PacketSnapshot> {
        let mut packet = ffmpeg::Packet::empty();
        match input.read_packet(&mut packet) {
            Ok(()) => Some(PacketSnapshot {
                stream: packet.stream(),
                pts: packet.pts(),
                dts: packet.dts(),
                duration: packet.duration(),
                flags: packet.flags().bits(),
                bytes: packet.data().unwrap_or_default().to_vec(),
            }),
            Err(ffmpeg::Error::Eof) => None,
            Err(error) => panic!("Unexpected packet failure: {error}"),
        }
    }

    #[test]
    fn live_ffmpeg_packets_and_seeks_survive_relocation_failure_and_rollback() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let retained = directory.path().join("retained");
        let reference = directory.path().join("reference");
        std::fs::create_dir(&original).unwrap();
        std::fs::create_dir(&reference).unwrap();
        let paths = wave_parts(&original);
        let reference_paths = wave_parts(&reference);
        let relative = relative_parts(&paths);
        let source = RelocatableSource::new(original.clone()).unwrap();
        let mut input =
            SegmentedInput::open_relocatable(&source, relative.iter().map(PathBuf::as_path))
                .unwrap();
        let mut baseline =
            SegmentedInput::open(reference_paths.iter().map(PathBuf::as_path)).unwrap();
        let context = unsafe { input.input().as_ptr() };
        assert!(input.io.reader.position + 65_536 < input.io.reader.length);
        for _ in 0..8 {
            assert_eq!(next_snapshot(&mut input), next_snapshot(&mut baseline));
        }
        source.relocate(retained.clone()).unwrap();
        std::fs::create_dir(&original).unwrap();
        let replacement = original.join(&relative[0]);
        std::fs::write(&replacement, b"ordinary published output").unwrap();
        let mut ordinary_output = ConcatenatedFiles::new([replacement.as_path()]).unwrap();
        let mut bytes = Vec::new();
        ordinary_output.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"ordinary published output");
        drop(ordinary_output);
        let mut continued_bytes = 0;
        loop {
            let actual = next_snapshot(&mut input);
            let expected = next_snapshot(&mut baseline);
            assert_eq!(actual, expected);
            let Some(actual) = actual else { break };
            continued_bytes += actual.bytes.len();
        }
        assert!(continued_bytes > 1_000_000);
        assert_eq!(
            source.relocate(original.clone()).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        for timestamp in [19_000_000, 0, 8_000_000, 1_000_000] {
            input.seek(timestamp).unwrap();
            baseline.seek(timestamp).unwrap();
            for _ in 0..8 {
                assert_eq!(next_snapshot(&mut input), next_snapshot(&mut baseline));
            }
        }
        std::fs::remove_file(replacement).unwrap();
        std::fs::remove_dir(&original).unwrap();
        source.relocate(original.clone()).unwrap();
        for timestamp in [0, 18_000_000, 2_000_000] {
            input.seek(timestamp).unwrap();
            baseline.seek(timestamp).unwrap();
            for _ in 0..16 {
                assert_eq!(next_snapshot(&mut input), next_snapshot(&mut baseline));
            }
        }
        assert_eq!(unsafe { input.input().as_ptr() }, context);
        assert!(input.io_error().is_none());
        for (original, reference) in paths.iter().zip(reference_paths) {
            assert_eq!(
                std::fs::read(original).unwrap(),
                std::fs::read(reference).unwrap()
            );
        }
    }

    #[test]
    fn live_ffmpeg_input_moves_to_a_worker_and_keeps_reading_after_relocation() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let reference = directory.path().join("reference");
        std::fs::create_dir(&original).unwrap();
        std::fs::create_dir(&reference).unwrap();
        let paths = wave_parts(&original);
        let reference_paths = wave_parts(&reference);
        let mut baseline =
            SegmentedInput::open(reference_paths.iter().map(PathBuf::as_path)).unwrap();
        let mut expected = Vec::new();
        while let Some(packet) = next_snapshot(&mut baseline) {
            expected.push(packet);
        }
        let source = RelocatableSource::new(original).unwrap();
        let relative = relative_parts(&paths);
        let mut input =
            SegmentedInput::open_relocatable(&source, relative.iter().map(PathBuf::as_path))
                .unwrap();
        let (ready, ready_rx) = std::sync::mpsc::channel();
        let (resume, resume_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut actual = vec![next_snapshot(&mut input).unwrap()];
            ready.send(()).unwrap();
            resume_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            while let Some(packet) = next_snapshot(&mut input) {
                actual.push(packet);
            }
            actual
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        source.relocate(directory.path().join("retained")).unwrap();
        resume.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), expected);
    }

    #[test]
    fn managed_missing_lazy_part_is_a_sticky_io_failure() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        std::fs::create_dir(&original).unwrap();
        let paths = wave_parts(&original);
        let relative = relative_parts(&paths);
        let source = RelocatableSource::new(original).unwrap();
        let mut input =
            SegmentedInput::open_relocatable(&source, relative.iter().map(PathBuf::as_path))
                .unwrap();
        assert!(input.io.reader.position + 65_536 < input.io.reader.length);
        std::fs::remove_file(paths.last().unwrap()).unwrap();
        let mut failed = false;
        for _ in 0..1_000 {
            let mut packet = ffmpeg::Packet::empty();
            match input.read_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EIO => {
                    failed = true;
                    break;
                }
                Err(error) => panic!("Missing source was misreported: {error}"),
            }
        }
        assert!(failed);
        assert_eq!(input.io_error().unwrap().kind(), io::ErrorKind::NotFound);
        assert!(input.seek(0).is_err());
        assert!(input.read_packet(&mut ffmpeg::Packet::empty()).is_err());
        assert_eq!(input.io_error().unwrap().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn managed_interrupt_is_owned_before_open_and_remains_sticky() {
        let directory = tempfile::tempdir().unwrap();
        let paths = wave_parts(directory.path());
        let relative = relative_parts(&paths);
        let source = RelocatableSource::new(directory.path().to_path_buf()).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let weak = Arc::downgrade(&cancelled);
        let owned = cancelled.clone();
        let mut input = SegmentedInput::open_relocatable_interruptible(
            &source,
            relative.iter().map(PathBuf::as_path),
            Arc::new(move || owned.load(Ordering::Relaxed)),
        )
        .unwrap();
        assert!(next_snapshot(&mut input).is_some());
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(
            input.read_packet(&mut ffmpeg::Packet::empty()),
            Err(ffmpeg::Error::Exit)
        );
        assert_eq!(input.io_error().unwrap().kind(), io::ErrorKind::Interrupted);
        cancelled.store(false, Ordering::Relaxed);
        assert_eq!(input.seek(0), Err(ffmpeg::Error::Exit));
        drop(cancelled);
        assert!(weak.upgrade().is_some());
        drop(input);
        assert!(weak.upgrade().is_none());

        let marker = Arc::new(());
        let weak = Arc::downgrade(&marker);
        let cancelled = Arc::new(move || {
            let _ = &marker;
            true
        });
        let missing = Path::new("missing");
        let error = SegmentedInput::open_relocatable_interruptible(&source, [missing], cancelled)
            .err()
            .unwrap();
        assert!(error.to_string().contains("cancelled"));
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn panicking_interrupt_cannot_unwind_through_ffmpeg() {
        let directory = tempfile::tempdir().unwrap();
        let source = RelocatableSource::new(directory.path().to_path_buf()).unwrap();
        let result = SegmentedInput::open_relocatable_interruptible(
            &source,
            [Path::new("missing")],
            Arc::new(|| panic!("interrupted")),
        );
        assert!(result.err().unwrap().to_string().contains("cancelled"));
    }

    #[test]
    fn managed_registration_observes_cancellation_between_bounded_batches() {
        let directory = tempfile::tempdir().unwrap();
        let paths = wave_parts(directory.path());
        let source = RelocatableSource::new(directory.path().to_path_buf()).unwrap();
        let relative: Vec<_> = paths
            .iter()
            .map(|path| PathBuf::from(path.file_name().unwrap()))
            .collect();
        std::fs::remove_file(&paths[64]).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let interrupt = Arc::new(InterruptState {
            callback: Arc::new(move || observed.fetch_add(1, Ordering::Relaxed) >= 2),
            cancelled: AtomicBool::new(false),
        });
        let result = ConcatenatedFiles::new_relocatable(
            &source,
            relative.iter().map(PathBuf::as_path),
            Some(interrupt),
        );
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::Interrupted);
        assert_eq!(calls.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn cancellation_callback_can_relocate_between_registration_batches() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let retained = directory.path().join("retained");
        std::fs::create_dir(&original).unwrap();
        let paths = wave_parts(&original);
        let expected: Vec<u8> = paths
            .iter()
            .flat_map(|path| std::fs::read(path).unwrap())
            .collect();
        let relative: Vec<_> = paths
            .iter()
            .map(|path| PathBuf::from(path.file_name().unwrap()))
            .collect();
        let source = RelocatableSource::new(original.clone()).unwrap();
        let callback_source = source.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let interrupt = Arc::new(InterruptState {
            callback: Arc::new(move || {
                if observed.fetch_add(1, Ordering::Relaxed) == 2 {
                    callback_source
                        .relocate_from(&original, retained.clone())
                        .unwrap();
                }
                false
            }),
            cancelled: AtomicBool::new(false),
        });
        let mut reader = ConcatenatedFiles::new_relocatable(
            &source,
            relative.iter().map(PathBuf::as_path),
            Some(interrupt),
        )
        .unwrap();
        let mut actual = Vec::new();
        reader.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, expected);
        assert!(calls.load(Ordering::Relaxed) > 3);
    }
}
