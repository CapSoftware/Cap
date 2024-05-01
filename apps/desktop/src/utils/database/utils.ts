export const saveUserId = async (userId: string) => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    try {
      window.localStorage.setItem("userId", userId);
    } catch (error) {
      console.error(error);
    }
  }
};

export const getUserId = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    return window.localStorage.getItem("userId") || "";
  }
};
