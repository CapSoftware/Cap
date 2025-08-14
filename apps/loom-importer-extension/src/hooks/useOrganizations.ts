import { useState, useEffect, useMemo } from "react";
import { CapApi } from "../api/cap";
import type { Organization } from "../types";
import { useImportStore } from "../store/importStore";
import { CapUrls } from "../utils/urls";

export function useOrganizations(isAuthenticated: boolean) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const { setSelectedOrganizationId, data } = useImportStore();
  const selectedOrganizationId = data.selectedOrganizationId;

  const [isError, setIsError] = useState(false);
  const [status, setStatus] = useState("");

  const api = useMemo(() => new CapApi(), []);

  useEffect(() => {
    let isMounted = true;
    const fetchOrganizations = async () => {
      if (isAuthenticated) {
        try {
          const organizationData = await api.getOrganizations();
          if (isMounted) {
            setOrganizations(organizationData.data || []);
          }
        } catch (error) {
          console.error("Error fetching organizations:", error);
          if (isMounted) {
            setIsError(true);
          }
        }
      }
    };

    fetchOrganizations();

    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, api]);

  const handleOrganizationSelect = (organizationId: string) => {
    setSelectedOrganizationId(organizationId);
    setIsError(false);
    setStatus("");
  };

  const createOrganization = () => {
    chrome.tabs.create({
      url: CapUrls.CREATE_ORGANIZATION,
    });
  };

  return {
    organizations,
    selectedOrganizationId,
    isError,
    status,
    handleOrganizationSelect,
    createOrganization,
  };
}
