import { LoomExportData } from "../types/loom";
import { getApiBaseUrl } from "../utils/urls";

interface ApiResponse<T> {
  data: T;
  error?: string;
}

interface UserResponse {
  user: User;
  expires: string;
}
interface User {
  name: string;
  email: string;
  image: string;
  id: string;
}

interface LoomImportResponse {
  success: boolean;
  message: string;
}

interface Organization {
  id: string;
  name: string;
  ownerId: string;
  metadata: null;
  allowedEmailDomain: null;
  customDomain: null;
  domainVerified: null;
  createdAt: string;
  updatedAt: string;
  workosOrganizationId: null;
  workosConnectionId: null;
}

interface OrganizationResponse {
  data: Organization[];
}

export class CapApi {
  private baseUrl = getApiBaseUrl();
  private headers: HeadersInit = {
    accept: "*/*",
    "content-type": "application/json",
  };

  private async getAuthToken(): Promise<string | null> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getAuthStatus" }, (response) => {
        resolve(response?.token || null);
      });
    });
  }

  private async getHeaders(): Promise<HeadersInit> {
    const token = await this.getAuthToken();
    return {
      ...this.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          ...headers,
          ...options.headers,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "API request failed");
      }

      return { data: data as T };
    } catch (error) {
      return {
        data: {} as T,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  public async getUser(): Promise<UserResponse> {
    const response = await this.request<UserResponse>("/auth/session");
    return response.data;
  }

  /**
   * Sends imported Loom data to Cap.so
   * @param loomData The exported Loom data to import into Cap.so
   * @returns Response with import status
   */
  public async sendLoomData(
    loomData: LoomExportData
  ): Promise<LoomImportResponse> {
    const response = await this.request<LoomImportResponse>("/import/loom", {
      method: "POST",
      body: JSON.stringify(loomData),
    });

    if (response.error) {
      return {
        success: false,
        message: response.error,
      };
    }

    return response.data;
  }

  public async getOrganizations(): Promise<OrganizationResponse> {
    const response = await this.request<OrganizationResponse>("/organizations");
    return response.data;
  }
}
