export const enumerateAndStoreDevices = async () => {
  await navigator.mediaDevices.getUserMedia({ audio: true });
  const devices = await navigator.mediaDevices.enumerateDevices();

  const audioDevices = devices.filter((device) => device.kind === "audioinput");

  window.localStorage.setItem("audioDevices", JSON.stringify(audioDevices));
};

export const getLocalDevices = async () => {
  const audioDevices = JSON.parse(
    window.localStorage.getItem("audioDevices") || "[]"
  ) as MediaDeviceInfo[];

  console.log("audioDevices:", audioDevices);

  return { audioDevices };
};

export const getSelectedVideoProperties = async () => {
  const videoDeviceProperties = JSON.parse(
    window.localStorage.getItem("videoDeviceProperties") || "{}"
  );

  return videoDeviceProperties;
};
