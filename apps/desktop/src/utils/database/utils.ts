export const saveLatestVideoId = async (videoId: string) => {
  try {
    window.localStorage.setItem("latestVideoId", videoId);
  } catch (error) {
    console.error(error);
  }
};

export const getLatestVideoId = async () => {
  return window.localStorage.getItem("latestVideoId") || "";
};
