import os
from pathlib import Path
import subprocess

path = Path('crates/editor/src/audio.rs')
original = path.read_text()
needle = 'let mut g = gain;'
assert original.count(needle) == 1
path.write_text(original.replace(needle, 'let mut g = gain * 1.29;'))
try:
    result = subprocess.run(
        ['cargo', 'test', '--profile', 'ci-verify', '-p', 'cap-verify', '--test', 'audio', 'studio_sound_music_is_additive', '--', '--nocapture'],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    Path(os.environ['RUNNER_TEMP'], 'ssmusic-mutant.log').write_text(result.stdout)
    assert result.returncode != 0
    assert 'music differs by' in result.stdout
    print('CAUGHT: product music gain +29% by independent source-sample oracle')
finally:
    path.write_text(original)
