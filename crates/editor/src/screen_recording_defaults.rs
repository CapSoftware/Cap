use cap_project::{ProjectConfiguration, ScreenMovementSpring};

pub fn default_screen_recording_project_config() -> ProjectConfiguration {
    let mut config = ProjectConfiguration::default();
    if config.background.padding <= f64::EPSILON {
        config.background.padding = 10.0;
    }
    if config.background.rounding <= f64::EPSILON {
        config.background.rounding = 7.5;
    }
    if (config.screen_movement_spring.stiffness - 120.0).abs() < f32::EPSILON
        && (config.screen_movement_spring.damping - 14.0).abs() < f32::EPSILON
        && (config.screen_movement_spring.mass - 1.0).abs() < f32::EPSILON
    {
        config.screen_movement_spring = ScreenMovementSpring::default();
    }
    config
}
