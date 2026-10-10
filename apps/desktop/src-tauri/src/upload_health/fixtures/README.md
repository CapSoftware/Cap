# Upload probe fixture

`probe.mp4` is a synthetic test pattern, with no screen capture, user content or audio. It contains 30 H.264 frames at 640 by 360 pixels over one second. A trailing ISO BMFF `free` box brings the file to exactly 262,144 bytes so the network sample retains a stable size.

Generate it with Node.js and FFmpeg 7.1 using libx264:

```sh
FFMPEG_BIN=/path/to/ffmpeg node generate-probe.mjs
ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,pix_fmt,nb_read_frames,duration:format=duration,size -of json probe.mp4
ffmpeg -v error -xerror -i probe.mp4 -f null -
```

The committed fixture was generated with the Windows FFmpeg 7.1 full shared build linked by the repository setup script: [Gyan FFmpeg 7.1](https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-full_build-shared.zip). Its SHA-256 is `2a53c14ff7bd4380890b938b9d238455661b9aca84c169c8e17215235e46ef5d`. Repeated generation with that build produces identical bytes. Other encoder versions may produce different bytes, so a deliberate fixture change must also update the native expected digest and test expectations.

The server computes the digest of the bytes received and the desktop compares it with this fixture. This checks authenticated API upload integrity. It does not exercise the user's screen capture, encoder, or recording storage configuration.
