"use client";

import { useState, useEffect, useRef } from "react";
import { users } from "@cap/database/schema";
import { Mic, Video, Monitor } from "lucide-react";
import { Rnd } from "react-rnd";
import {
  Button,
  Logo,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cap/ui";
import { ActionButton } from "./_components/ActionButton";
import toast from "react-hot-toast";

// million-ignore
export const Record = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const [startingRecording, setStartingRecording] = useState(false);
  const [stoppingRecording, setStoppingRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [currentStoppingMessage, setCurrentStoppingMessage] =
    useState("Stopping Recording");
  const [recordingTime, setRecordingTime] = useState("00:00");

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>();
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>();
  const [selectedAudioDeviceLabel, setSelectedAudioDeviceLabel] =
    useState("Microphone");
  const [selectedVideoDeviceLabel, setSelectedVideoDeviceLabel] =
    useState("Webcam");

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
  const screenPreviewRef = useRef<HTMLVideoElement>(null);
  const webcamPreviewRef = useRef<HTMLVideoElement>(null);

  const buttonStyles =
    "w-full h-full flex flex-col items-center justify-center text-center space-y-1 py-2 pl-5 pr-7 group-hover:bg-gray-300 rounded-xl";

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
      const displayMediaOptions = {
        video: {
          displaySurface: "browser",
        },
        audio: false,
        surfaceSwitching: "exclude",
        selfBrowserSurface: "exclude",
        systemAudio: "exclude",
      };

      const stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions
      );
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
      setStartingRecording(true);

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
          const containerRect = document
            .querySelector(".aspect-w-16.aspect-h-9")
            ?.getBoundingClientRect();

          if (containerRect) {
            const scaleX = canvas.width / containerRect.width;
            const scaleY = canvas.height / containerRect.height;

            const camWidth = webcamRect.width * scaleX;
            const camHeight = webcamRect.height * scaleY;
            const camX = (webcamRect.left - containerRect.left) * scaleX;
            const camY = (webcamRect.top - containerRect.top) * scaleY;

            // Calculate the aspect ratio of the original webcam video
            const videoWidth = webcamPreview.videoWidth;
            const videoHeight = webcamPreview.videoHeight;
            const aspectRatio = videoWidth / videoHeight;

            // Adjust the webcam preview size to maintain the aspect ratio
            let newWidth = camWidth;
            let newHeight = camWidth / aspectRatio;
            if (newHeight > camHeight) {
              newWidth = camHeight * aspectRatio;
              newHeight = camHeight;
            }

            // Calculate the position to center the adjusted webcam preview
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
          }

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

      mediaRecorder.start();
      setIsRecording(true);
      setStartingRecording(false);
      setMediaRecorder(mediaRecorder);
    } else {
      toast.error("No source selected for recording");
    }
  };

  const stopRecording = () => {
    setStoppingRecording(true);

    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      setIsRecording(false);
      setStoppingRecording(false);
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

  useEffect(() => {
    if (screenPreviewRef.current && screenStream) {
      screenPreviewRef.current.srcObject = screenStream;
    }
    if (webcamPreviewRef.current && videoStream) {
      webcamPreviewRef.current.srcObject = videoStream;
    }
  }, [screenStream, videoStream]);

  useEffect(() => {
    if (stoppingRecording) {
      const messages = ["Processing video", "Almost done", "Finishing up"];
      let messageIndex = 0;

      const nextMessage = () => {
        setCurrentStoppingMessage(messages[messageIndex % messages.length]);
        messageIndex++;
      };

      nextMessage();

      const intervalId = setInterval(nextMessage, 2500);

      return () => clearInterval(intervalId);
    } else {
      setCurrentStoppingMessage("");
    }
  }, [stoppingRecording]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    if (isRecording && !startingRecording) {
      const startTime = Date.now();

      intervalId = setInterval(() => {
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(seconds / 60);
        const formattedSeconds =
          seconds % 60 < 10 ? `0${seconds % 60}` : seconds % 60;
        setRecordingTime(`${minutes}:${formattedSeconds}`);
      }, 1000);
    }

    return () => {
      clearInterval(intervalId);
      setRecordingTime("00:00");
    };
  }, [isRecording, startingRecording]);

  useEffect(() => {
    const storedAudioDevice = localStorage.getItem("selectedAudioDevice");
    const storedVideoDevice = localStorage.getItem("selectedVideoDevice");
    const storedScreenStream = localStorage.getItem("screenStream");

    if (storedAudioDevice) {
      setSelectedAudioDevice(storedAudioDevice);
      const selectedAudioDeviceObj = audioDevices.find(
        (device) => device.deviceId === storedAudioDevice
      );
      if (selectedAudioDeviceObj) {
        setSelectedAudioDeviceLabel(selectedAudioDeviceObj.label);
      }
    }
    if (storedVideoDevice) {
      setSelectedVideoDevice(storedVideoDevice);
      const selectedVideoDeviceObj = videoDevices.find(
        (device) => device.deviceId === storedVideoDevice
      );
      if (selectedVideoDeviceObj) {
        setSelectedVideoDeviceLabel(selectedVideoDeviceObj.label);
      }
      startVideoCapture(storedVideoDevice);
    }
    if (storedScreenStream === "true") {
      startScreenCapture();
    }
  }, [audioDevices, videoDevices]);

  return (
    <div className="w-full h-screen bg-white flex flex-row-reverse">
      <div className="min-w-[500px] h-full flex items-center justify-center">
        <div className="w-full max-w-[290px] px-4 py-14 border-2 rounded-[15px] flex flex-col items-center justify-center bg-gradient-to-b from-white to-gray-200">
          <div className="flex items-center justify-between mb-4">
            <div>
              <Logo showVersion className="w-24 h-auto" />
            </div>
          </div>
          <div className="space-y-4 mb-4 w-full">
            <div>
              <label className="text-sm font-medium">Display</label>
              <div className="flex items-center space-x-1">
                <ActionButton
                  handler={() => {
                    screenStream ? stopScreenCapture() : startScreenCapture();
                  }}
                  icon={<Monitor className="w-5 h-5" />}
                  label={screenStream ? "Hide display" : "Select display"}
                  active={true}
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Webcam / Video</label>
              <div className="space-y-2">
                <DropdownMenu>
                  <DropdownMenuTrigger className="w-full">
                    <ActionButton
                      width="full"
                      icon={<Video className="w-5 h-5" />}
                      label={selectedVideoDeviceLabel}
                      active={true}
                      recordingOption={true}
                      optionName="Video"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-56">
                    {videoDevices.map((device) => (
                      <DropdownMenuItem
                        key={device.deviceId}
                        onSelect={() => {
                          setSelectedVideoDevice(device.deviceId);
                          setSelectedVideoDeviceLabel(device.label);
                          startVideoCapture(device.deviceId);
                        }}
                      >
                        {device.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger className="w-full">
                    <ActionButton
                      width="full"
                      icon={<Mic className="w-5 h-5" />}
                      label={selectedAudioDeviceLabel}
                      active={true}
                      recordingOption={true}
                      optionName="Audio"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-56">
                    {audioDevices.map((device) => (
                      <DropdownMenuItem
                        key={device.deviceId}
                        onSelect={() => {
                          setSelectedAudioDevice(device.deviceId);
                          setSelectedAudioDeviceLabel(device.label);
                          startVideoCapture(device.deviceId);
                        }}
                      >
                        {device.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
          <div className="group flex flex-col items-center justify-center w-full">
            <Button
              {...(isRecording && { variant: "destructive" })}
              className="w-full flex mx-auto"
              onClick={() => {
                if (isRecording) {
                  stopRecording();
                } else {
                  startRecording();
                }
              }}
              spinner={startingRecording || stoppingRecording}
            >
              {startingRecording
                ? "Starting..."
                : isRecording
                ? stoppingRecording
                  ? currentStoppingMessage
                  : `Stop - ${recordingTime}`
                : "Start Recording"}
            </Button>
          </div>
        </div>
      </div>

      <div className="h-full flex-grow">
        <div className="w-full h-full top-0 left-0 h-full flex flex-col items-center justify-center p-8">
          <div className="w-full text-left mb-4">
            <span className="bg-white shadow-lg py-2 px-4 rounded-xl font-medium text-lg border-2">
              Recording preview
            </span>
          </div>
          <div className="bg-black relative w-full aspect-w-16 aspect-h-9 mx-auto border-2 border-gray-200 rounded-xl overflow-hidden shadow-xl">
            <video
              id="screenPreview"
              ref={screenPreviewRef}
              autoPlay
              muted
              className="w-full h-full object-contain"
            />
            {videoStream && (
              <Rnd
                default={{
                  x: 18,
                  y: 18,
                  width: 160,
                  height: 160,
                }}
                bounds="parent"
                className="absolute"
                lockAspectRatio={true}
              >
                <div className="w-full h-full rounded-full overflow-hidden">
                  <video
                    id="webcamPreview"
                    ref={webcamPreviewRef}
                    autoPlay
                    muted
                    className="w-full h-full object-cover rounded-full"
                  />
                </div>
              </Rnd>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
