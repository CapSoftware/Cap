import os
from pathlib import Path

root = Path(os.environ["RUNNER_TEMP"]) / "mixer-gate"
probe = Path("scripts/verify/mixer-gate-probe.rs").read_text()
wrapper = """
#[cfg(test)]
impl AudioMixer {
    pub(crate) fn tick_for_gate_probe(&mut self, now: Timestamp) -> anyhow::Result<bool> {
        self.tick(self.timestamps, now)
    }
}
"""
for arm in ["main", "candidate"]:
    core = root / f"{arm}-core.rs"
    source = core.read_text()
    arm_probe = probe
    if "    capture_time_pause: bool," not in source:
        arm_probe = probe.replace("                                    capture_time_pause: true,\n", "")
    core.write_text(source + "\n" + arm_probe)
    mixer = root / f"{arm}-mixer.rs"
    mixer.write_text(mixer.read_text() + wrapper)
