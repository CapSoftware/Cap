```
/{userId}/{videoId}
  /transcription.vtt - Transcription file
  /screenshot/screen-capture.jpg - Screen capture
  /preview/hover.mp4 - Hover preview clip
  /output
	 	/video_recording_000.m3u8 - Master playlist
	 	/video_recording_000_output.m3u8 - MediaConvert playlist
		/video_recording_000_output_x.ts - MediaConvert video segments
  /video
   	/video_recording_x.ts - Uploaded MPEG-TS video segments
  /audio
  	/audio_recording_x.aac - Uploaded aac audio segments

  /transcription.vtt
  /screenshot/screen-capture.jpg
  /combined-source
  	/stream.m3u8 - Client-generated m3u8 file
  	/segment_x.ts - Client-generated HLS segment
  /generated
  	/all-audio.mp3 - All audio in one mp3 file for transcription
   	/everything.mp4 - Everything together for downloading
```
