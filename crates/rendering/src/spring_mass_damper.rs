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

const REST_VELOCITY_THRESHOLD: f32 = 0.0001;
const REST_DISPLACEMENT_THRESHOLD: f32 = 0.00001;

fn solve_spring_1d(displacement: f32, velocity: f32, t: f32, omega0: f32, zeta: f32) -> (f32, f32) {
    if zeta < 1.0 - 1e-6 {
        let omega_d = omega0 * (1.0 - zeta * zeta).sqrt();
        let decay = (-zeta * omega0 * t).exp();
        let cos_term = (omega_d * t).cos();
        let sin_term = (omega_d * t).sin();

        let a = displacement;
        let b = (velocity + displacement * zeta * omega0) / omega_d.max(1e-6);

        let new_disp = decay * (a * cos_term + b * sin_term);
        let new_vel = decay
            * ((b * omega_d - a * zeta * omega0) * cos_term
                - (a * omega_d + b * zeta * omega0) * sin_term);

        (new_disp, new_vel)
    } else if zeta > 1.0 + 1e-6 {
        let sqrt_term = (zeta * zeta - 1.0).sqrt();
        let s1 = -omega0 * (zeta - sqrt_term);
        let s2 = -omega0 * (zeta + sqrt_term);
        let denom = s1 - s2;

        if denom.abs() < 1e-10 {
            let decay = (-omega0 * t).exp();
            let new_disp = decay * (displacement + (velocity + displacement * omega0) * t);
            let new_vel = decay * (velocity - omega0 * displacement);
            (new_disp, new_vel)
        } else {
            let c1 = (velocity - displacement * s2) / denom;
            let c2 = displacement - c1;

            let e1 = (s1 * t).exp();
            let e2 = (s2 * t).exp();

            let new_disp = c1 * e1 + c2 * e2;
            let new_vel = c1 * s1 * e1 + c2 * s2 * e2;

            (new_disp, new_vel)
        }
    } else {
        let decay = (-omega0 * t).exp();
        let a = displacement;
        let b = velocity + displacement * omega0;

        let new_disp = decay * (a + b * t);
        let new_vel = decay * (b - omega0 * (a + b * t));

        (new_disp, new_vel)
    }
}

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

    pub fn set_config(&mut self, config: SpringMassDamperSimulationConfig) {
        self.tension = config.tension;
        self.mass = config.mass;
        self.friction = config.friction;
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

    pub fn run(&mut self, dt_ms: f32) -> XY<f32> {
        if dt_ms <= 0.0 {
            return self.position;
        }

        let t = dt_ms / 1000.0;
        let mass = self.mass.max(0.001);
        let stiffness = self.tension;
        let damping = self.friction;

        let omega0 = (stiffness / mass).sqrt();
        let zeta = damping / (2.0 * (stiffness * mass).sqrt());

        let disp_x = self.position.x - self.target_position.x;
        let disp_y = self.position.y - self.target_position.y;

        let (new_disp_x, new_vel_x) = solve_spring_1d(disp_x, self.velocity.x, t, omega0, zeta);
        let (new_disp_y, new_vel_y) = solve_spring_1d(disp_y, self.velocity.y, t, omega0, zeta);

        self.position = XY::new(
            self.target_position.x + new_disp_x,
            self.target_position.y + new_disp_y,
        );
        self.velocity = XY::new(new_vel_x, new_vel_y);

        let disp_mag = (new_disp_x * new_disp_x + new_disp_y * new_disp_y).sqrt();
        let vel_mag = (new_vel_x * new_vel_x + new_vel_y * new_vel_y).sqrt();

        if disp_mag < REST_DISPLACEMENT_THRESHOLD && vel_mag < REST_VELOCITY_THRESHOLD {
            self.position = self.target_position;
            self.velocity = XY::new(0.0, 0.0);
        }

        self.position
    }
}
