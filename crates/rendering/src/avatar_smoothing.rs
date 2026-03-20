use crate::spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig};
use cap_face_tracking::FacePose;
use cap_project::XY;

pub struct FacePoseSmoother {
    pitch_spring: SpringMassDamperSimulation,
    yaw_spring: SpringMassDamperSimulation,
    roll_spring: SpringMassDamperSimulation,
    mouth_spring: SpringMassDamperSimulation,
    left_eye_spring: SpringMassDamperSimulation,
    right_eye_spring: SpringMassDamperSimulation,
}

impl FacePoseSmoother {
    pub fn new() -> Self {
        let head_config = SpringMassDamperSimulationConfig {
            tension: 300.0,
            mass: 1.5,
            friction: 25.0,
        };
        let fast_config = SpringMassDamperSimulationConfig {
            tension: 500.0,
            mass: 0.8,
            friction: 20.0,
        };

        fn make_spring(config: SpringMassDamperSimulationConfig) -> SpringMassDamperSimulation {
            let mut sim = SpringMassDamperSimulation::new(config);
            sim.set_position(XY::new(0.0, 0.0));
            sim.set_velocity(XY::new(0.0, 0.0));
            sim.set_target_position(XY::new(0.0, 0.0));
            sim
        }

        Self {
            pitch_spring: make_spring(head_config),
            yaw_spring: make_spring(head_config),
            roll_spring: make_spring(head_config),
            mouth_spring: make_spring(fast_config),
            left_eye_spring: make_spring(fast_config),
            right_eye_spring: make_spring(fast_config),
        }
    }

    pub fn update(&mut self, raw_pose: &FacePose, dt_ms: f32) -> FacePose {
        self.pitch_spring
            .set_target_position(XY::new(raw_pose.head_pitch, 0.0));
        self.yaw_spring
            .set_target_position(XY::new(raw_pose.head_yaw, 0.0));
        self.roll_spring
            .set_target_position(XY::new(raw_pose.head_roll, 0.0));
        self.mouth_spring
            .set_target_position(XY::new(raw_pose.mouth_open, 0.0));
        self.left_eye_spring
            .set_target_position(XY::new(raw_pose.left_eye_open, 0.0));
        self.right_eye_spring
            .set_target_position(XY::new(raw_pose.right_eye_open, 0.0));

        self.pitch_spring.run(dt_ms);
        self.yaw_spring.run(dt_ms);
        self.roll_spring.run(dt_ms);
        self.mouth_spring.run(dt_ms);
        self.left_eye_spring.run(dt_ms);
        self.right_eye_spring.run(dt_ms);

        FacePose {
            head_pitch: self.pitch_spring.position.x,
            head_yaw: self.yaw_spring.position.x,
            head_roll: self.roll_spring.position.x,
            mouth_open: self.mouth_spring.position.x.clamp(0.0, 1.0),
            left_eye_open: self.left_eye_spring.position.x.clamp(0.0, 1.0),
            right_eye_open: self.right_eye_spring.position.x.clamp(0.0, 1.0),
            confidence: raw_pose.confidence,
        }
    }
}
