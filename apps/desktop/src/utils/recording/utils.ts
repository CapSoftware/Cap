export const enumerateAndStoreDevices = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();

    const videoDevices = devices.filter(
      (device) => device.kind === "videoinput"
    );
    const audioDevices = devices.filter(
      (device) => device.kind === "audioinput"
    );

    window.localStorage.setItem("videoDevices", JSON.stringify(videoDevices));
    window.localStorage.setItem("audioDevices", JSON.stringify(audioDevices));
  }
};

export const getLocalDevices = async () => {
  const videoDevices = JSON.parse(
    window.localStorage.getItem("videoDevices") || "[]"
  ) as MediaDeviceInfo[];

  const audioDevices = JSON.parse(
    window.localStorage.getItem("audioDevices") || "[]"
  ) as MediaDeviceInfo[];

  return { audioDevices, videoDevices };
};

export const getSelectedVideoProperties = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    const videoDeviceProperties = JSON.parse(
      window.localStorage.getItem("videoDeviceProperties") || "{}"
    );

    return videoDeviceProperties;
  }
};
