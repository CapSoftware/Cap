use cap_project::{NEW_PROJECT_ROUNDING, ProjectConfiguration};

const DEFAULT_BACKGROUND_PADDING: f64 = 10.0;

pub fn default_screen_recording_project_config() -> ProjectConfiguration {
    let mut config = ProjectConfiguration::for_new_project();
    if config.background.padding <= f64::EPSILON {
        config.background.padding = DEFAULT_BACKGROUND_PADDING;
    }
    if config.background.rounding <= f64::EPSILON {
        config.background.rounding = NEW_PROJECT_ROUNDING;
    }
    config.auto_zoom_pending = false;
    config
}
