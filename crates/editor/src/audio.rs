use std::sync::Arc;

#[derive(Clone)]
pub struct AudioData {
    pub buffer: Arc<Vec<f64>>,
    pub sample_rate: u32,
    // pub channels: u18
}
