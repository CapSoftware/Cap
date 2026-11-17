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
    cached_step: Option<CachedSpringStep>,
}

const REST_VELOCITY_THRESHOLD: f32 = 0.0001;
const REST_DISPLACEMENT_THRESHOLD: f32 = 0.00001;

/// `solve` keeps the original per-step operand order, so cached steps stay
/// bit-identical to solving afresh.
#[derive(Clone, Copy)]
enum SpringStep {
    Underdamped {
        omega0: f32,
        zeta: f32,
        omega_d: f32,
        b_divisor: f32,
        decay: f32,
        cos_term: f32,
        sin_term: f32,
    },
    Overdamped {
        s1: f32,
        s2: f32,
        denom: f32,
        e1: f32,
        e2: f32,
    },
    OverdampedDegenerate {
        t: f32,
        s_avg: f32,
        decay: f32,
    },
    CriticallyDamped {
        t: f32,
        omega0: f32,
        decay: f32,
    },
}

impl SpringStep {
    fn new(t: f32, omega0: f32, zeta: f32) -> Self {
        const CRITICAL_EPSILON: f32 = 0.01;

        if zeta < 1.0 - CRITICAL_EPSILON {
            let omega_d = omega0 * (1.0 - zeta * zeta).sqrt();
            Self::Underdamped {
                omega0,
                zeta,
                omega_d,
                b_divisor: omega_d.max(1e-4),
                decay: (-zeta * omega0 * t).exp(),
                cos_term: (omega_d * t).cos(),
                sin_term: (omega_d * t).sin(),
            }
        } else if zeta > 1.0 + CRITICAL_EPSILON {
            let sqrt_term = (zeta * zeta - 1.0).sqrt();
            let s1 = -omega0 * (zeta - sqrt_term);
            let s2 = -omega0 * (zeta + sqrt_term);
            let denom = s1 - s2;

            if denom.abs() < 1e-10 {
                let s_avg = 0.5 * (s1 + s2);
                Self::OverdampedDegenerate {
                    t,
                    s_avg,
                    decay: (s_avg * t).exp(),
                }
            } else {
                Self::Overdamped {
                    s1,
                    s2,
                    denom,
                    e1: (s1 * t).exp(),
                    e2: (s2 * t).exp(),
                }
            }
        } else {
            Self::CriticallyDamped {
                t,
                omega0,
                decay: (-omega0 * t).exp(),
            }
        }
    }

    fn solve(self, displacement: f32, velocity: f32) -> (f32, f32) {
        match self {
            Self::Underdamped {
                omega0,
                zeta,
                omega_d,
                b_divisor,
                decay,
                cos_term,
                sin_term,
            } => {
                let a = displacement;
                let b = (velocity + displacement * zeta * omega0) / b_divisor;

                let new_disp = decay * (a * cos_term + b * sin_term);
                let new_vel = decay
                    * ((b * omega_d - a * zeta * omega0) * cos_term
                        - (a * omega_d + b * zeta * omega0) * sin_term);

                (new_disp, new_vel)
            }
            Self::Overdamped {
                s1,
                s2,
                denom,
                e1,
                e2,
            } => {
                let c1 = (velocity - displacement * s2) / denom;
                let c2 = displacement - c1;

                let new_disp = c1 * e1 + c2 * e2;
                let new_vel = c1 * s1 * e1 + c2 * s2 * e2;

                (new_disp, new_vel)
            }
            Self::OverdampedDegenerate { t, s_avg, decay } => {
                let new_disp = decay * (displacement + (velocity - displacement * s_avg) * t);
                let new_vel = decay
                    * ((velocity - displacement * s_avg)
                        + s_avg * (displacement + (velocity - displacement * s_avg) * t));
                (new_disp, new_vel)
            }
            Self::CriticallyDamped { t, omega0, decay } => {
                let a = displacement;
                let b = velocity + displacement * omega0;

                let new_disp = decay * (a + b * t);
                let new_vel = decay * (b - omega0 * (a + b * t));

                (new_disp, new_vel)
            }
        }
    }
}

#[derive(Clone, Copy)]
struct CachedSpringStep {
    key: [u32; 4],
    step: SpringStep,
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
            cached_step: None,
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

    pub(crate) fn is_at_rest(&self) -> bool {
        self.position == self.target_position && self.velocity == XY::new(0.0, 0.0)
    }

    fn step(&mut self, dt_ms: f32) -> SpringStep {
        let key = [dt_ms, self.tension, self.mass, self.friction].map(f32::to_bits);
        if let Some(cached) = self.cached_step
            && cached.key == key
        {
            return cached.step;
        }

        let t = dt_ms / 1000.0;
        let mass = self.mass.max(0.001);
        let stiffness = self.tension;
        let damping = self.friction;

        let omega0 = (stiffness / mass).sqrt();
        let zeta = damping / (2.0 * (stiffness * mass).sqrt());

        let step = SpringStep::new(t, omega0, zeta);
        self.cached_step = Some(CachedSpringStep { key, step });
        step
    }

    pub fn run(&mut self, dt_ms: f32) -> XY<f32> {
        if dt_ms <= 0.0 {
            return self.position;
        }

        let step = self.step(dt_ms);

        let disp_x = self.position.x - self.target_position.x;
        let disp_y = self.position.y - self.target_position.y;

        let (new_disp_x, new_vel_x) = step.solve(disp_x, self.velocity.x);
        let (new_disp_y, new_vel_y) = step.solve(disp_y, self.velocity.y);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn original_solve_spring_1d(
        displacement: f32,
        velocity: f32,
        t: f32,
        omega0: f32,
        zeta: f32,
    ) -> (f32, f32) {
        const CRITICAL_EPSILON: f32 = 0.01;

        if zeta < 1.0 - CRITICAL_EPSILON {
            let omega_d = omega0 * (1.0 - zeta * zeta).sqrt();
            let decay = (-zeta * omega0 * t).exp();
            let cos_term = (omega_d * t).cos();
            let sin_term = (omega_d * t).sin();

            let a = displacement;
            let b = (velocity + displacement * zeta * omega0) / omega_d.max(1e-4);

            let new_disp = decay * (a * cos_term + b * sin_term);
            let new_vel = decay
                * ((b * omega_d - a * zeta * omega0) * cos_term
                    - (a * omega_d + b * zeta * omega0) * sin_term);

            (new_disp, new_vel)
        } else if zeta > 1.0 + CRITICAL_EPSILON {
            let sqrt_term = (zeta * zeta - 1.0).sqrt();
            let s1 = -omega0 * (zeta - sqrt_term);
            let s2 = -omega0 * (zeta + sqrt_term);
            let denom = s1 - s2;

            if denom.abs() < 1e-10 {
                let s_avg = 0.5 * (s1 + s2);
                let decay = (s_avg * t).exp();
                let new_disp = decay * (displacement + (velocity - displacement * s_avg) * t);
                let new_vel = decay
                    * ((velocity - displacement * s_avg)
                        + s_avg * (displacement + (velocity - displacement * s_avg) * t));
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

    fn original_run(
        config: SpringMassDamperSimulationConfig,
        position: &mut XY<f32>,
        velocity: &mut XY<f32>,
        target: XY<f32>,
        dt_ms: f32,
    ) {
        let t = dt_ms / 1000.0;
        let mass = config.mass.max(0.001);
        let stiffness = config.tension;
        let damping = config.friction;

        let omega0 = (stiffness / mass).sqrt();
        let zeta = damping / (2.0 * (stiffness * mass).sqrt());

        let disp_x = position.x - target.x;
        let disp_y = position.y - target.y;

        let (new_disp_x, new_vel_x) = original_solve_spring_1d(disp_x, velocity.x, t, omega0, zeta);
        let (new_disp_y, new_vel_y) = original_solve_spring_1d(disp_y, velocity.y, t, omega0, zeta);

        *position = XY::new(target.x + new_disp_x, target.y + new_disp_y);
        *velocity = XY::new(new_vel_x, new_vel_y);

        let disp_mag = (new_disp_x * new_disp_x + new_disp_y * new_disp_y).sqrt();
        let vel_mag = (new_vel_x * new_vel_x + new_vel_y * new_vel_y).sqrt();

        if disp_mag < REST_DISPLACEMENT_THRESHOLD && vel_mag < REST_VELOCITY_THRESHOLD {
            *position = target;
            *velocity = XY::new(0.0, 0.0);
        }
    }

    #[test]
    fn cached_spring_steps_match_original_solver() {
        let configs = [
            SpringMassDamperSimulationConfig {
                tension: 200.0,
                mass: 2.25,
                friction: 40.0,
            },
            SpringMassDamperSimulationConfig {
                tension: 100.0,
                mass: 1.0,
                friction: 20.0,
            },
            SpringMassDamperSimulationConfig {
                tension: 50.0,
                mass: 1.0,
                friction: 200.0,
            },
            SpringMassDamperSimulationConfig {
                tension: 1e-24,
                mass: 1.0,
                friction: 1e-11,
            },
            SpringMassDamperSimulationConfig {
                tension: 400.0,
                mass: 0.0,
                friction: 1.0,
            },
        ];
        let mut cached = SpringMassDamperSimulation::new(configs[0]);
        cached.set_position(XY::new(0.1, 0.9));
        let mut position = cached.position;
        let mut velocity = cached.velocity;
        for step in 0..2_000usize {
            let config = configs[(step / 97) % configs.len()];
            let target = XY::new(((step / 150) % 3) as f32 * 0.4, 0.5);
            let dt_ms = if step % 11 == 0 { 16.0 } else { 8.0 };

            original_run(config, &mut position, &mut velocity, target, dt_ms);

            cached.set_config(config);
            cached.set_target_position(target);
            cached.run(dt_ms);

            assert_eq!(
                [
                    cached.position.x,
                    cached.position.y,
                    cached.velocity.x,
                    cached.velocity.y
                ]
                .map(f32::to_bits),
                [position.x, position.y, velocity.x, velocity.y].map(f32::to_bits),
                "step {step}"
            );
        }
    }
}
