pub struct SegmentationModel;

impl SegmentationModel {
    pub fn new() -> anyhow::Result<Self> {
        anyhow::bail!("Camera segmentation is unavailable in the browser")
    }

    pub fn run_inference(&mut self, _rgba_256x256: &[u8]) -> anyhow::Result<&[f32]> {
        anyhow::bail!("Camera segmentation is unavailable in the browser")
    }
}

pub(crate) fn init_runtime() -> anyhow::Result<()> {
    Ok(())
}
