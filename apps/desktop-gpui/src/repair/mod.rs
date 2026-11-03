pub mod availability;
mod bridge;
mod media;
mod paths;
mod protocol;
mod redact;
mod sanitize;
mod session;
mod submission;
mod tools;
pub mod window;
mod workspace;

pub use session::{
    RepairController, RepairOperation, RepairPhase, RepairRequest, RepairSnapshot, ToolVerb,
    TraceItem, TraceState, start,
};
pub use workspace::{bundle_busy, recover_interrupted_repairs};

pub fn init(cx: &mut gpui::App) {
    availability::start(cx);
    cx.background_executor()
        .spawn(async {
            recover_interrupted_repairs(&crate::library::known_recordings_dirs());
        })
        .detach();
}
