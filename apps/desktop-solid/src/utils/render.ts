import { convertFileSrc } from "@tauri-apps/api/core";

interface RenderOptions {
  screenRecordingPath: string;
  webcamRecordingPath: string;
  webcamSize: { width: number; height: number };
  webcamPosition: { x: number; y: number };
  webcamStyle: {
    borderRadius: number;
    shadowColor: string;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
  };
  outputSize: { width: number; height: number };
  background: {
    type: "color" | "gradient";
    value: string | { start: string; end: string; angle: number };
  };
  padding: number;
}

export async function renderVideo(options: RenderOptions): Promise<string> {
  const canvas = new OffscreenCanvas(
    options.outputSize.width,
    options.outputSize.height
  );
  const ctx = canvas.getContext("2d")!;

  const screenVideo = document.createElement("video");
  screenVideo.src = convertFileSrc(options.screenRecordingPath);
  await screenVideo.play();

  const webcamVideo = document.createElement("video");
  webcamVideo.src = convertFileSrc(options.webcamRecordingPath);
  await webcamVideo.play();

  const duration = Math.max(screenVideo.duration, webcamVideo.duration);
  const fps = 30;
  const totalFrames = Math.ceil(duration * fps);

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      // Handle encoded video chunks
    },
    error: (error) => {
      console.error("Encoding error:", error);
    },
  });

  await encoder.configure({
    codec: "vp9",
    width: options.outputSize.width,
    height: options.outputSize.height,
    bitrate: 5_000_000, // 5 Mbps
    framerate: fps,
  });

  for (let frame = 0; frame < totalFrames; frame++) {
    const time = frame / fps;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background
    if (options.background.type === "color") {
      ctx.fillStyle = options.background.value as string;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      const gradient = ctx.createLinearGradient(
        0,
        0,
        canvas.width,
        canvas.height
      );
      const { start, end, angle } = options.background.value as {
        start: string;
        end: string;
        angle: number;
      };
      gradient.addColorStop(0, start);
      gradient.addColorStop(1, end);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Draw screen recording
    const screenX = options.padding;
    const screenY = options.padding;
    const screenWidth = canvas.width - options.padding * 2;
    const screenHeight = canvas.height - options.padding * 2;
    ctx.drawImage(screenVideo, screenX, screenY, screenWidth, screenHeight);

    // Draw webcam
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(
      options.webcamPosition.x,
      options.webcamPosition.y,
      options.webcamSize.width,
      options.webcamSize.height,
      options.webcamStyle.borderRadius
    );
    ctx.clip();
    ctx.drawImage(
      webcamVideo,
      options.webcamPosition.x,
      options.webcamPosition.y,
      options.webcamSize.width,
      options.webcamSize.height
    );
    ctx.restore();

    // Apply webcam shadow
    ctx.shadowColor = options.webcamStyle.shadowColor;
    ctx.shadowBlur = options.webcamStyle.shadowBlur;
    ctx.shadowOffsetX = options.webcamStyle.shadowOffsetX;
    ctx.shadowOffsetY = options.webcamStyle.shadowOffsetY;
    ctx.strokeStyle = "rgba(0,0,0,0)";
    ctx.strokeRect(
      options.webcamPosition.x,
      options.webcamPosition.y,
      options.webcamSize.width,
      options.webcamSize.height
    );
    ctx.shadowColor = "transparent";

    // Encode frame
    const videoFrame = new VideoFrame(canvas, { timestamp: time * 1000000 });
    encoder.encode(videoFrame);
    videoFrame.close();

    // Seek videos to next frame
    screenVideo.currentTime = time;
    webcamVideo.currentTime = time;

    // Wait for videos to seek
    await Promise.all([
      new Promise((resolve) =>
        screenVideo.addEventListener("seeked", resolve, { once: true })
      ),
      new Promise((resolve) =>
        webcamVideo.addEventListener("seeked", resolve, { once: true })
      ),
    ]);
  }

  await encoder.flush();
  encoder.close();

  // TODO: Implement muxing of encoded video chunks into an MP4 file
  // For now, we'll return a placeholder path
  return "/path/to/rendered/video.mp4";
}
