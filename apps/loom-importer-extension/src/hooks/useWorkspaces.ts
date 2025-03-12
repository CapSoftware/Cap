import { useState, useEffect, useMemo } from "react";
import { CapApi } from "../api/cap";
import { Workspace } from "../types";
import { useImportStore } from "../store/importStore";
import { CapUrls } from "../utils/urls";

export function useWorkspaces(isAuthenticated: boolean) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const { setSelectedWorkspaceId, data } = useImportStore();
  const selectedWorkspaceId = data.selectedWorkspaceId;

  const [isError, setIsError] = useState(false);
  const [status, setStatus] = useState("");

  const api = useMemo(() => new CapApi(), []);

  useEffect(() => {
    let isMounted = true;
    const fetchWorkspaces = async () => {
      if (isAuthenticated) {
        try {
          const workspaceData = await api.getWorkspaceDetails();
          if (isMounted) {
            setWorkspaces(workspaceData.workspaces || []);
          }
        } catch (error) {
          console.error("Error fetching workspaces:", error);
          if (isMounted) {
            setIsError(true);
          }
        }
      }
    };

    fetchWorkspaces();

    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, api]);

  const handleWorkspaceSelect = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setIsError(false);
    setStatus("");
  };

  const createWorkspace = () => {
    chrome.tabs.create({
      url: CapUrls.CREATE_WORKSPACE,
    });
  };

  return {
    workspaces,
    selectedWorkspaceId,
    isError,
    status,
    handleWorkspaceSelect,
    createWorkspace,
  };
}
