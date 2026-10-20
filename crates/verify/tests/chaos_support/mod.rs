pub mod actors;
pub mod fragments;
pub mod fuzz;
pub mod harness;
pub mod media_check;
pub mod project;
pub mod record;

pub fn all() -> Vec<harness::Probe> {
    let mut out = record::probes();
    out.extend(project::probes());
    out.extend(fragments::probes());
    out.extend(fuzz::probes());
    out
}
