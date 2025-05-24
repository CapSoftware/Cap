use cap_project::XY;

#[derive(Clone, Copy)]
pub struct SpringMassDamperSimulationConfig {
    pub tension: f32,
    pub mass: f32,
    pub friction: f32,
}

pub struct SpringMassDamperSimulation {
    tension: f32,
    mass: f32,
    friction: f32,
    pub position: XY<f32>,
    pub velocity: XY<f32>,
    pub target_position: XY<f32>,
}

const SIMULATION_TICK: f32 = 1000.0 / 60.0;

impl SpringMassDamperSimulation {
    pub fn new(config: SpringMassDamperSimulationConfig) -> Self {
        Self {
            tension: config.tension,
            mass: config.mass,
            friction: config.friction,
            position: XY::new(0.0, 0.0),
            velocity: XY::new(0.0, 0.0),
            target_position: XY::new(0.0, 0.0),
        }
    }

    pub fn set_position(&mut self, position: XY<f32>) {
        self.position = position;
    }
    pub fn set_velocity(&mut self, velocity: XY<f32>) {
        self.velocity = velocity;
    }
    pub fn set_target_position(&mut self, target_position: XY<f32>) {
        self.target_position = target_position;
    }

    pub fn run(&mut self, dt: f32) -> XY<f32> {
        if dt == 0.0 {
            return self.position;
        }

        let mut t = 0.0;

        loop {
            let d = self.target_position - self.position;
            let spring_force = d * self.tension;

            let damping_force = self.velocity * -self.friction;

            let total_force = spring_force + damping_force;

            let accel = total_force / self.mass.max(0.001);

            let tick = (SIMULATION_TICK / 1000.0).min(dt - t);

            self.velocity = self.velocity + accel * tick;
            self.position = self.position + self.velocity * tick;

            if t >= dt {
                break;
            }

            t = (t + SIMULATION_TICK).min(dt);
        }

        self.position
    }
}
