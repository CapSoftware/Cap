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

export const saveUserId = async (userId: string) => {
  try {
    window.localStorage.setItem("userId", userId);
  } catch (error) {
    console.error(error);
  }
};

export const getUserId = async () => {
  return window.localStorage.getItem("userId") || "";
};
