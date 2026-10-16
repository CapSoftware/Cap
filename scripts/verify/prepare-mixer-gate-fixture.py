from pathlib import Path

path = Path("crates/verify/src/pipeline.rs")
source = path.read_text()
old = """        gate.arm();
    }
    emitted.screen_sent = video_emit.await.context("video emit")?;"""
new = """        if std::env::var_os("CAP_VERIFY_FIXED_ARM").is_some() {
            assert!(gate.arm_at(timestamps + Duration::from_secs_f64(arm_at)));
        } else {
            assert!(gate.arm());
        }
        let actual = gate.armed_at().expect("armed gate");
        let actual_ns = actual.instant().duration_since(base).as_nanos();
        let first_screen_ns = emitted.screen.iter()
            .map(|(_, seconds)| Duration::from_secs_f64(*seconds).as_nanos())
            .find(|time| *time >= actual_ns)
            .expect("screen frame after gate");
        eprintln!("MIXER_FIXTURE_GATE actual_ns={actual_ns} first_screen_ns={first_screen_ns} phase_ns={}", first_screen_ns - actual_ns);
    }
    emitted.screen_sent = video_emit.await.context("video emit")?;"""
assert source.count(old) == 1
path.write_text(source.replace(old, new))
