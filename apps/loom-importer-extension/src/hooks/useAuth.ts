import { useState, useCallback, useEffect, useMemo } from "react";
import { CapApi } from "../api/cap";
import { AuthResponse, User } from "../types";
import { CapUrls } from "../utils/urls";

interface AuthState {
  status: string;
  token: string;
  isError: boolean;
  isAuthenticated: boolean;
  user: User | null;
}

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({
    status: "",
    token: "",
    isError: false,
    isAuthenticated: false,
    user: null,
  });

  const api = useMemo(() => new CapApi(), []);

  const fetchUserData = useCallback(async () => {
    try {
      const userData = await api.getUser();
      if (!userData.user) {
        return;
      }
      setAuthState((prev) => ({
        ...prev,
        user: {
          name: userData.user.name,
          image: userData.user.image,
        },
      }));
    } catch (error) {
      console.error("Error fetching user data:", error);
      setAuthState((prev) => ({ ...prev, isError: true }));
    }
  }, [api]);

  useEffect(() => {
    let isMounted = true;
    const updateAuthState = (
      status: string,
      token?: string,
      isError: boolean = false,
      isAuthenticated: boolean = false
    ) => {
      if (!isMounted) return;

      setAuthState((prev) => ({
        ...prev,
        status,
        isError,
        token: token || "No token found",
        isAuthenticated,
      }));
    };

    try {
      chrome.runtime.sendMessage(
        { action: "getAuthStatus" },
        async (response: AuthResponse) => {
          if (!isMounted) return;

          if (chrome.runtime.lastError) {
            updateAuthState(
              "Error checking authentication status",
              undefined,
              true,
              false
            );
            console.error("Runtime error:", chrome.runtime.lastError);
            return;
          }

          if (response && response.token) {
            const timestamp = response.timestamp
              ? new Date(response.timestamp).toLocaleTimeString()
              : "unknown";
            updateAuthState(
              `Authenticated (Last updated: ${timestamp})`,
              response.token,
              false,
              true
            );
            await fetchUserData();
          } else {
            updateAuthState("Not authenticated", undefined, true, false);
          }
        }
      );
    } catch (error) {
      if (!isMounted) return;

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      updateAuthState(`Error: ${errorMessage}`, undefined, true, false);
      console.error("Error in useAuth:", error);
    }

    return () => {
      isMounted = false;
    };
  }, [fetchUserData]);

  const handleLogin = () => {
    chrome.tabs.create({
      url: CapUrls.LOGIN,
    });
  };

  const handleLogout = () => {
    chrome.storage.local.clear(() => {
      console.log("Storage cleared");
      setAuthState({
        status: "Not authenticated",
        token: "",
        isError: false,
        isAuthenticated: false,
        user: null,
      });
    });
  };

  return {
    ...authState,
    handleLogin,
    handleLogout,
  };
}
