use std::path::Path;
use windows::{
    Storage::{
        CreationCollisionOption, FileAccessMode, StorageFile, StorageFolder,
        Streams::IRandomAccessStream,
    },
    Win32::Media::MediaFoundation::{
        IMFMediaType, IMFSample, IMFSinkWriter, MFCreateAttributes, MFCreateMFByteStreamOnStreamEx,
        MFCreateSinkWriterFromURL,
    },
    core::{HSTRING, Result},
};

pub struct SampleWriter {
    _stream: IRandomAccessStream,
    _file: StorageFile,
    sink_writer: IMFSinkWriter,
}

unsafe impl Send for SampleWriter {}
unsafe impl Sync for SampleWriter {}

impl SampleWriter {
    pub fn new(path: &Path) -> Result<Self> {
        let parent_folder_path = path.parent().unwrap();
        let parent_folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(
            parent_folder_path.as_os_str().to_str().unwrap(),
        ))
        .unwrap()
        .get()
        .unwrap();
        let file_name = path.file_name().unwrap();
        let file = parent_folder
            .CreateFileAsync(
                &HSTRING::from(file_name.to_str().unwrap()),
                CreationCollisionOption::ReplaceExisting,
            )
            .unwrap()
            .get()
            .unwrap();

        let stream = file
            .OpenAsync(FileAccessMode::ReadWrite)
            .unwrap()
            .get()
            .unwrap();

        let empty_attributes = unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 0)?;
            attributes.unwrap()
        };
        let sink_writer = unsafe {
            let byte_stream = MFCreateMFByteStreamOnStreamEx(&stream).unwrap();
            MFCreateSinkWriterFromURL(&HSTRING::from(".mp4"), &byte_stream, &empty_attributes)
                .unwrap()
        };

        Ok(Self {
            _stream: stream,
            _file: file,
            sink_writer,
        })
    }

    pub fn add_stream(&self, output_type: &IMFMediaType) -> Result<StreamIndex> {
        let empty_attributes = unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 0)?;
            attributes.unwrap()
        };

        let sink_writer_stream_index = unsafe { self.sink_writer.AddStream(output_type) }?;
        unsafe {
            self.sink_writer.SetInputMediaType(
                sink_writer_stream_index,
                output_type,
                &empty_attributes,
            )
        }?;

        Ok(StreamIndex(sink_writer_stream_index))
    }

    pub fn start(&self) -> Result<()> {
        unsafe { self.sink_writer.BeginWriting() }
    }

    pub fn stop(&self) -> Result<()> {
        unsafe { self.sink_writer.Finalize() }
    }

    pub fn write(&self, stream: StreamIndex, sample: &IMFSample) -> Result<()> {
        unsafe { self.sink_writer.WriteSample(stream.0, sample) }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StreamIndex(u32);
