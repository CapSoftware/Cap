import { writeFile, readFile } from "@tauri-apps/plugin-fs";
import MP4Box from "mp4box";

const outputFilePath =
  "/Users/richie/Library/Application Support/so.cap.desktop-solid/recordings/ac2909e0-2f5e-45ff-95e3-8efb50a56a12.cap/output/result.mp4";

interface VideoSettings {
  webcamSize: { width: number; height: number };
  webcamPosition: { x: number; y: number };
  webcamStyle: { borderRadius: number; shadow: string };
  videoOutputSize: { width: number; height: number };
  videoBackground: string;
  videoPadding: number;
}

async function loadVideo(filePath: string): Promise<VideoFrame[]> {
  console.log(`Loading video from ${filePath}`);
  const response = await readFile(filePath);
  const arrayBuffer = response.buffer;
  const frames: VideoFrame[] = [];

  return new Promise<VideoFrame[]>((resolve, reject) => {
    const mp4boxFile = MP4Box.createFile();

    mp4boxFile.onReady = async (info: any) => {
      console.log("MP4Box file ready:", info);
      const videoTrack = info.tracks.find(
        (track: any) => track.type === "video"
      );

      if (!videoTrack) {
        reject(new Error("No video track found"));
        return;
      }

      console.log("Video track found:", videoTrack);

      const codecs = [
        "avc1.42001E",
        "avc1.42E01E",
        "avc1.4D401E",
        "vp8",
        "vp09.00.10.08",
        "av01.0.04M.08",
      ];
      const accelerations = [
        "prefer-hardware",
        "prefer-software",
        "no-preference",
      ];

      let supportedConfig = null;
      let videoDecoder: VideoDecoder | null = null;

      for (const codec of codecs) {
        for (const acceleration of accelerations) {
          const config = {
            codec,
            hardwareAcceleration: acceleration as HardwareAcceleration,
            codedWidth: videoTrack.video.width,
            codedHeight: videoTrack.video.height,
          };

          try {
            const support = await VideoDecoder.isConfigSupported(config);
            console.log(
              `VideoDecoder config ${JSON.stringify(config)} support: ${
                support.supported
              }`
            );

            if (support.supported) {
              supportedConfig = config;
              videoDecoder = new VideoDecoder({
                output: (frame: VideoFrame) => {
                  console.log("Decoded frame:", frame);
                  frames.push(frame);
                },
                error: (e: DOMException) => {},
              });

              try {
                videoDecoder.configure(supportedConfig);
                console.log(
                  "Successfully configured decoder with:",
                  supportedConfig
                );
                break;
              } catch (configError) {
                console.error("Error configuring decoder:", configError);
                videoDecoder = null;
              }
            }
          } catch (error) {
            console.error(`Error checking config support: ${error}`);
          }
        }

        if (videoDecoder) break;
      }

      if (!supportedConfig || !videoDecoder) {
        reject(new Error("No supported codec configuration found"));
        return;
      }

      try {
        mp4boxFile.setExtractionOptions(videoTrack.id, null, {
          nbSamples: Infinity,
        });
        mp4boxFile.start();

        mp4boxFile.onSamples = async (
          track_id: number,
          user: any,
          samples: any[]
        ) => {
          console.log(
            `Received ${samples.length} samples for track ${track_id}`
          );
          let decodedSampleCount = 0;
          for (const sample of samples) {
            const retryDecode = (attempts: number = 0) => {
              if (attempts >= 3 || !videoDecoder) {
                console.error(
                  `Failed to decode sample ${
                    decodedSampleCount + 1
                  } after ${attempts} attempts`
                );
                return;
              }

              try {
                videoDecoder.decode(
                  new EncodedVideoChunk({
                    type: sample.is_sync ? "key" : "delta",
                    timestamp: sample.cts,
                    duration: sample.duration,
                    data: new Uint8Array(sample.data),
                  })
                );
                decodedSampleCount++;
              } catch (decodeError) {
                console.error(
                  `Error decoding sample ${decodedSampleCount + 1} (attempt ${
                    attempts + 1
                  }):`,
                  decodeError
                );
                retryDecode(attempts + 1);
              }
            };

            retryDecode();

            if (decodedSampleCount === samples.length) {
              console.log("Flushing decoder");
              mp4boxFile.flush();
              await videoDecoder.flush();
              console.log("Video decoding complete");
              if (frames.length > 0) {
                console.log("Resolving frames");
                resolve(frames);
              } else {
                reject(new Error("No frames were decoded"));
              }
            }
          }
          console.log(`Total samples decoded: ${decodedSampleCount}`);
        };

        const mp4ArrayBuffer = arrayBuffer as ArrayBuffer & {
          fileStart: number;
        };
        mp4ArrayBuffer.fileStart = 0;
        mp4boxFile.appendBuffer(mp4ArrayBuffer);
      } catch (error) {
        console.error("Error setting up video decoding:", error);
        reject(error);
      }
    };

    mp4boxFile.onError = (e: Error) => {
      console.error("MP4Box error:", e);
      reject(e);
    };

    const mp4ArrayBuffer = arrayBuffer as ArrayBuffer & { fileStart: number };
    mp4ArrayBuffer.fileStart = 0;
    mp4boxFile.appendBuffer(mp4ArrayBuffer);
  });
}

function applyTransformations(
  screenFrames: VideoFrame[],
  webcamFrames: VideoFrame[],
  settings: VideoSettings
): VideoFrame[] {
  console.log("Applying transformations with settings:", settings);
  return screenFrames.map((screenFrame, index) => {
    const webcamFrame = webcamFrames[index % webcamFrames.length];
    console.log(`Transforming frame ${index}`);

    // Create a canvas to draw the frame
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = settings.videoOutputSize.width;
    canvas.height = settings.videoOutputSize.height;

    if (!ctx) {
      throw new Error("Failed to get 2D context");
    }

    // Draw background
    ctx.fillStyle = settings.videoBackground;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw screen recording frame
    ctx.drawImage(screenFrame, settings.videoPadding, settings.videoPadding);

    // Draw webcam frame with transformations
    ctx.save();
    ctx.shadowColor = settings.webcamStyle.shadow;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(
      settings.webcamPosition.x + settings.webcamSize.width / 2,
      settings.webcamPosition.y + settings.webcamSize.height / 2,
      settings.webcamSize.width / 2,
      0,
      Math.PI * 2
    );
    ctx.clip();
    ctx.drawImage(
      webcamFrame,
      settings.webcamPosition.x,
      settings.webcamPosition.y,
      settings.webcamSize.width,
      settings.webcamSize.height
    );
    ctx.restore();

    // Convert canvas to VideoFrame
    const transformedFrame = new VideoFrame(canvas);
    console.log("Transformed frame:", transformedFrame);
    return transformedFrame;
  });
}

async function encodeVideo(frames: VideoFrame[]): Promise<string> {
  console.log("Encoding video with frames:", frames);
  const chunks: Uint8Array[] = [];
  const videoEncoder = new VideoEncoder({
    output: (chunk: EncodedVideoChunk) => {
      console.log("Encoded chunk:", chunk);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
    },
    error: (e: Error) => console.error("VideoEncoder error:", e),
  });

  for (const frame of frames) {
    console.log("Encoding frame:", frame);
    videoEncoder.encode(frame);
  }

  await videoEncoder.flush();
  console.log("Video encoding complete");

  // Save chunks to file
  const blob = new Blob(chunks, { type: "video/mp4" });

  // Convert Blob to Buffer
  const arrayBuffer = await blob.arrayBuffer();

  await writeFile(outputFilePath, new Uint8Array(arrayBuffer));
  console.log(`Video saved to ${outputFilePath}`);

  return outputFilePath;
}

export async function renderVideo(
  screenRecordingPath: string,
  webcamRecordingPath: string,
  settings: VideoSettings
): Promise<string> {
  console.log("Rendering video with settings:", settings);
  const screenFrames = await loadVideo(screenRecordingPath);
  console.log("Loaded screen frames:", screenFrames);
  const webcamFrames = await loadVideo(webcamRecordingPath);
  console.log("Loaded webcam frames:", webcamFrames);

  const transformedFrames = applyTransformations(
    screenFrames,
    webcamFrames,
    settings
  );
  console.log("Transformed frames:", transformedFrames);
  return await encodeVideo(transformedFrames);
}
