"use client";

import { useState, useEffect } from "react";
import { users } from "@cap/database/schema";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Monitor,
  CircleEllipsis,
  ChevronUp,
} from "lucide-react";
import { Rnd } from "react-rnd";

export const Record = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>();
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>();
  const [showAudioOptions, setShowAudioOptions] = useState(false);
  const [showVideoOptions, setShowVideoOptions] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [combinedStream, setCombinedStream] = useState<MediaStream | null>(
    null
  );
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(
    null
  );
  const [recordedBlobs, setRecordedBlobs] = useState<Blob[]>([]);

  const buttonStyles =
    "w-full h-full flex flex-col items-center justify-center text-center space-y-1 py-2 pl-5 pr-7 group-hover:bg-[#2e2d32] rounded-xl";

  const getDevices = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      console.log("Devices:", devices);
      const audioDevices = devices.filter(
        (device) => device.kind === "audioinput"
      );
      const videoDevices = devices.filter(
        (device) => device.kind === "videoinput"
      );
      setAudioDevices(audioDevices);
      setVideoDevices(videoDevices);
    } catch (error) {
      console.error("Error accessing media devices:", error);
    }
  };

  const startScreenCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      setScreenStream(stream);
    } catch (error) {
      console.error("Error capturing screen:", error);
    }
  };

  const startVideoCapture = async (deviceId?: string) => {
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId } : true,
        audio: selectedAudioDevice ? { deviceId: selectedAudioDevice } : false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setVideoStream(stream);
    } catch (error) {
      console.error("Error capturing video:", error);
    }
  };

  const stopScreenCapture = () => {
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      setScreenStream(null);
    }
  };

  const stopVideoCapture = () => {
    if (videoStream) {
      videoStream.getTracks().forEach((track) => track.stop());
      setVideoStream(null);
    }
  };

  const startRecording = async () => {
    if (screenStream && videoStream) {
      const combinedStream = new MediaStream();
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      const screenSize = screenStream.getVideoTracks()[0].getSettings();
      canvas.width = screenSize.width ?? 1280;
      canvas.height = screenSize.height ?? 720;

      let animationFrameId: number;

      const drawCanvas = () => {
        if (ctx) {
          ctx.drawImage(
            document.getElementById("screenPreview") as HTMLVideoElement,
            0,
            0,
            canvas.width,
            canvas.height
          );

          // Get the current position and size of the webcam preview
          const webcamPreview = document.getElementById(
            "webcamPreview"
          ) as HTMLVideoElement;
          const webcamRect = webcamPreview.getBoundingClientRect();
          const camWidth = webcamRect.width;
          const camHeight = webcamRect.height;
          const camX = webcamRect.left;
          const camY = webcamRect.top;

          // Calculate the aspect ratio of the video
          const videoWidth = webcamPreview.videoWidth;
          const videoHeight = webcamPreview.videoHeight;
          const aspectRatio = videoWidth / videoHeight;

          // Calculate the new dimensions based on the aspect ratio
          let newWidth = camWidth;
          let newHeight = camWidth / aspectRatio;
          if (newHeight > camHeight) {
            newWidth = camHeight * aspectRatio;
            newHeight = camHeight;
          }

          // Calculate the position to center the video
          const centerX = camX + (camWidth - newWidth) / 2;
          const centerY = camY + (camHeight - newHeight) / 2;

          // Set the position and size of the circular webcam preview on the canvas
          ctx.save();
          ctx.beginPath();
          ctx.arc(
            centerX + newWidth / 2,
            centerY + newHeight / 2,
            Math.min(newWidth, newHeight) / 2,
            0,
            2 * Math.PI
          );
          ctx.clip();
          ctx.drawImage(webcamPreview, centerX, centerY, newWidth, newHeight);
          ctx.restore();
          animationFrameId = requestAnimationFrame(drawCanvas);
        }
      };

      drawCanvas();

      const canvasStream = canvas.captureStream(30);
      canvasStream
        .getVideoTracks()
        .forEach((track) => combinedStream.addTrack(track));

      videoStream
        .getAudioTracks()
        .forEach((track) => combinedStream.addTrack(track));

      setCombinedStream(combinedStream);

      const options = { mimeType: "video/webm; codecs=vp9,opus" };
      const mediaRecorder = new MediaRecorder(combinedStream, options);
      const recordedChunks: Blob[] = [];

      mediaRecorder.ondataavailable = function (event) {
        if (event.data.size > 0) recordedChunks.push(event.data);
      };

      mediaRecorder.onstop = () => {
        cancelAnimationFrame(animationFrameId);
        const recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
        console.log("Recorded Blob:", recordedBlob);
        setRecordedBlobs([recordedBlob]);
      };

      setIsRecording(true);
      mediaRecorder.start();
      setMediaRecorder(mediaRecorder);
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      setIsRecording(false);
      mediaRecorder.stop();
    }
  };

  useEffect(() => {
    getDevices();
  }, []);

  useEffect(() => {
    if (recordedBlobs.length > 0) {
      const recordedVideo = new Blob(recordedBlobs, { type: "video/webm" });
      const videoUrl = URL.createObjectURL(recordedVideo);
      const link = document.createElement("a");
      link.href = videoUrl;
      link.download = "recorded_video.webm";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(videoUrl);
      setRecordedBlobs([]);
    }
  }, [recordedBlobs]);

  useEffect(() => {
    const storedAudioDevice = localStorage.getItem("selectedAudioDevice");
    const storedVideoDevice = localStorage.getItem("selectedVideoDevice");
    const storedScreenStream = localStorage.getItem("screenStream");

    if (storedAudioDevice) {
      setSelectedAudioDevice(storedAudioDevice);
    }
    if (storedVideoDevice) {
      setSelectedVideoDevice(storedVideoDevice);
      startVideoCapture(storedVideoDevice);
    }
    if (storedScreenStream === "true") {
      startScreenCapture();
    }
  }, []);

  useEffect(() => {
    if (selectedAudioDevice) {
      localStorage.setItem("selectedAudioDevice", selectedAudioDevice);
    } else {
      localStorage.removeItem("selectedAudioDevice");
    }
    if (selectedVideoDevice) {
      localStorage.setItem("selectedVideoDevice", selectedVideoDevice);
    } else {
      localStorage.removeItem("selectedVideoDevice");
    }
    if (screenStream) {
      localStorage.setItem("screenStream", "true");
    } else {
      localStorage.removeItem("screenStream");
    }
  }, [selectedAudioDevice, selectedVideoDevice, screenStream]);

  return (
    <div className="z-[1000000] absolute top-0 left-0 w-full h-full bg-black flex items-center justify-center">
      <div className="z-[1000001] absolute bottom-4 left-1/2 transform -translate-x-1/2 w-[90%] h-16 bg-[#212024] flex items-center justify-center rounded-full">
        <div className="w-full max-w-[650px] mx-auto flex justify-center items-center space-x-2">
          <div className="group flex items-center justify-center relative">
            <button
              className={buttonStyles}
              onClick={() => setShowAudioOptions(!showAudioOptions)}
            >
              {selectedAudioDevice ? (
                <Mic className="w-4 h-4 text-white" />
              ) : (
                <MicOff className="w-4 h-4 text-white" />
              )}
              <div className="text-white text-xs">
                {selectedAudioDevice ? "Mute audio" : "Unmute audio"}
              </div>
            </button>
            {showAudioOptions && (
              <div className="z-[1000002] absolute bottom-full left-0 bg-[#212024] w-full text-white rounded-md shadow-lg">
                {audioDevices.map((device) => (
                  <button
                    key={device.deviceId}
                    className="block w-full px-4 py-2 text-left hover:bg-[#2e2d32]"
                    onClick={() => {
                      setSelectedAudioDevice(device.deviceId);
                      setShowAudioOptions(false);
                    }}
                  >
                    {device.label}
                  </button>
                ))}
              </div>
            )}
            <button
              className="flex items-center justify-center absolute top-0 right-0 w-5 h-full hover:bg-[#424147] flex-grow rounded-tr-xl rounded-br-xl"
              onClick={() => setShowAudioOptions(!showAudioOptions)}
            >
              <ChevronUp className="w-2.5 h-2.5 text-white" />
            </button>
          </div>
          <div className="group flex items-center justify-center relative">
            <button
              className={buttonStyles}
              onClick={() => setShowVideoOptions(!showVideoOptions)}
            >
              {selectedVideoDevice ? (
                <Video className="w-4 h-4 text-white" />
              ) : (
                <VideoOff className="w-4 h-4 text-white" />
              )}
              <div className="text-white text-xs">
                {selectedVideoDevice ? "Stop camera" : "Show camera"}
              </div>
            </button>
            {showVideoOptions && (
              <div className="z-[1000002] absolute bottom-full left-0 bg-[#212024] w-full text-white rounded-md shadow-lg">
                {videoDevices.map((device) => (
                  <button
                    key={device.deviceId}
                    className="block w-full px-4 py-2 text-left hover:bg-[#2e2d32]"
                    onClick={() => {
                      setSelectedVideoDevice(device.deviceId);
                      startVideoCapture(device.deviceId);
                      setShowVideoOptions(false);
                    }}
                  >
                    {device.label}
                  </button>
                ))}
              </div>
            )}
            <button
              className="flex items-center justify-center absolute top-0 right-0 w-5 h-full hover:bg-[#424147] flex-grow rounded-tr-xl rounded-br-xl"
              onClick={() => setShowVideoOptions(!showVideoOptions)}
            >
              <ChevronUp className="w-2.5 h-2.5 text-white" />
            </button>
          </div>
          <div className="group flex flex-col items-center justify-center">
            <button
              onClick={() => {
                isRecording ? stopRecording() : startRecording();
              }}
              className="px-4 cursor-pointer disabled:cursor-not-allowed group"
            >
              <div className="shadow-recording-button group-enabled:hover:shadow-recording-heavy-button w-12 h-12 rounded-full flex items-center justify-center border border-red-700/50 border-4 group-enabled:hover:border-red-700 duration-300 transition">
                <div className="bg-red-700 group-disabled:!bg-red-700/50 transition duration-500 group-enabled:hover:!bg-red-700 w-8 h-8 rounded-full" />
              </div>
            </button>
          </div>
          <div className="group flex items-center justify-center">
            <button
              className={buttonStyles + " pl-5 pr-5"}
              onClick={screenStream ? stopScreenCapture : startScreenCapture}
            >
              <Monitor className="w-4 h-4 text-white" />
              <div className="text-white text-xs">
                {screenStream ? "Stop screen" : "Show screen"}
              </div>
            </button>
          </div>
          <div className="group flex items-center justify-center">
            <button className={buttonStyles + " pl-5 pr-5"}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                className="w-4 h-4 text-white"
                viewBox="0 0 24 24"
              >
                <circle cx="12" cy="12" r="1"></circle>
                <circle cx="19" cy="12" r="1"></circle>
                <circle cx="5" cy="12" r="1"></circle>
              </svg>
              <div className="text-white text-xs">More</div>
            </button>
          </div>
        </div>
      </div>
      {(screenStream || videoStream) && (
        <div className="aspect-video absolute top-8 left-0 w-full h-[calc(100%-8rem)] object-contain">
          <video
            id="screenPreview"
            ref={(video) => {
              if (video) {
                video.srcObject = screenStream;
              }
            }}
            autoPlay
            muted
            className="w-full h-full object-contain"
          />
          {videoStream && (
            <Rnd
              default={{
                x: 0,
                y: 0,
                width: 200,
                height: 200,
              }}
              bounds="parent"
              className="absolute bottom-8 left-8"
              lockAspectRatio={true}
            >
              <div className="w-full h-full rounded-full overflow-hidden">
                <video
                  id="webcamPreview"
                  ref={(video) => {
                    if (video) {
                      video.srcObject = videoStream;
                    }
                  }}
                  autoPlay
                  muted
                  className="w-full h-full object-cover"
                />
              </div>
            </Rnd>
          )}
        </div>
      )}
    </div>
  );
};
