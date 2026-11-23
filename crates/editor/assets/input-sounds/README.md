# Input sounds

Key press and mouse click sounds the editor can mix into preview and export
(Keyboard settings > Key sounds, Cursor settings > Click sounds).

Every recording below is CC0 1.0 (public domain dedication) on Freesound, so it
can be redistributed and modified without attribution. The credits are kept
here anyway.

| File | Sound | Source | Author | Licence |
| --- | --- | --- | --- | --- |
| `mechanical.opus` | Mechanical keyboard, isolated presses and releases | [mechanical keyboard.wav](https://freesound.org/people/AdrianoAnjos/sounds/404298/) | AdrianoAnjos | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `deep.opus` | Linear-switch keyboard, letters | [Keychron k10 A to + individual keys](https://freesound.org/people/Sadiquecat/sounds/789628/) | Sadiquecat | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `deep.opus` | Same keyboard, space bar | [Keychron k10 space_bar](https://freesound.org/people/Sadiquecat/sounds/789630/) | Sadiquecat | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `laptop.opus` | Laptop keyboard keystrokes | [Computer keyboard typing and keystrokes - Apple MacBook Pro 2018](https://freesound.org/people/khenshom/sounds/565645/) | khenshom | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `typewriter.opus` | Typewriter keys and carriage return | [Foley_Object_Typewriter_Keys_&_Return_Mono_NTG4.wav](https://freesound.org/people/Nox_Sound/sounds/550340/) | Nox_Sound | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `mouse.opus` | Mouse button presses and releases | [Computer Mouse Clicks - Single, Double and Soft Clicks](https://freesound.org/people/ApeinCave/sounds/855467/) | ApeinCave | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `trackpad.opus` | Laptop trackpad presses and releases | [trackpad computer (MacBook Pro).wav](https://freesound.org/people/seiswork/sounds/274220/) | seiswork | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

## Processing

Each pack is one Ogg Opus file (mono, 48 kHz, 96 kb/s VBR) holding every
sample back to back with 20 ms of silence between them. `src/input_sounds/packs.rs`
lists where each sample starts and how long it is, in 48 kHz frames from the
start of the decoded file.

From each source recording:

1. Downmixed to mono at 48 kHz and high-passed at 35 Hz (90 Hz for `deep`, whose
   source carries desk rumble). The laptop and trackpad sources were spectrally
   denoised against their own room tone.
2. Only isolated keystrokes or clicks were kept. Each is split at the release
   transient into a press sample and a release sample, starting 1 ms before its
   attack, trimmed where it decays 60 dB below its peak, and given a raised
   cosine fade out so no tail is cut off abruptly.
3. Press samples within a pack were levelled to the same short-term loudness
   (halfway toward the pack median, so natural variation survives), releases
   keep their level relative to their press, and every sample peaks below
   -1 dBFS.
4. The keys with the most low-frequency energy and the longest ring became the
   space, enter and backspace samples, the softest presses became modifiers,
   and the rest are letters. The typewriter's carriage return is its enter key.
