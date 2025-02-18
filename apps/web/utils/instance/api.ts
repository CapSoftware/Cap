import { serverConfigTable } from "@cap/database/schema";
import { INSTANCE_SITE_URL, LICENSE_SERVER_URL } from "./constants";

type LicenseApiTypes = {
  validate: {
    params: {
      usedSeats: number;
    };
    response: {
      refresh: string;
      isCapCloudLicense: boolean;
      isValid: boolean;
    };
    codes: {
      200: { refresh: string; isCapCloudLicense: boolean; isValid: boolean };
      402: { error: "License expired" };
      403: { error: "Too many seats" };
      404: { error: "License not found" };
      409: { error: "License already activated on another site" };
    };
  };
  addUserCheck: {
    params: {
      usedSeats: number;
    };
    response: void;
    codes: {
      200: { success: true };
      403: { error: "Too many seats" };
      404: { error: "License not found" };
    };
  };
  addUserPost: {
    params: {
      usedSeats: number;
    };
    response: void;
    codes: {
      200: { success: true };
      403: { error: "Too many seats" };
      404: { error: "License not found" };
    };
  };
  getUser: {
    params: {
      email: string;
    };
    response: {
      exists: boolean;
    };
    codes: {
      200: { exists: boolean };
      404: { error: "License not found" };
    };
  };
  workspace: {
    params: {
      workspaceId: string;
      name: string;
    };
    response: void;
    codes: {
      200: { success: true };
      404: { error: "License not found" };
    };
  };
  workspaceAddUser: {
    params: {
      workspaceId: string;
      email: string;
    };
    response: void;
    codes: {
      200: { success: true };
      403: { error: "Too many seats" };
      404: { error: "License or workspace not found" };
    };
  };
  workspaceCheckout: {
    params: {
      workspaceId: string;
      successUrl: string;
      cancelUrl: string;
    };
    response: {
      url: string;
    };
    codes: {
      200: { url: string };
      404: { error: "License or workspace not found" };
    };
  };
  workspacePortal: {
    params: {
      workspaceId: string;
    };
    response: {
      url: string;
    };
    codes: {
      200: { url: string };
      404: { error: "License or workspace not found" };
    };
  };
};

export function licenseApi(config: {
  serverConfig: typeof serverConfigTable.$inferSelect;
}) {
  if (!config.serverConfig.licenseKey || !config.serverConfig.licenseValid) {
    throw new Error("Server does not have a valid license");
  }

  const makeRequest = async <T>(
    endpoint: string,
    method: string,
    body: object
  ): Promise<T> => {
    const response = await fetch(`${LICENSE_SERVER_URL}/api/${endpoint}`, {
      method,
      headers: {
        licenseKey: config.serverConfig.licenseKey!,
        siteUrl: INSTANCE_SITE_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`License API error: ${response.status}`);
    }

    return response.json();
  };

  return {
    validate: (params: LicenseApiTypes["validate"]["params"]) =>
      makeRequest<LicenseApiTypes["validate"]["response"]>(
        "instances/validate",
        "POST",
        params
      ),

    addUserCheck: (params: LicenseApiTypes["addUserCheck"]["params"]) =>
      makeRequest<LicenseApiTypes["addUserCheck"]["response"]>(
        "instances/add-user/check",
        "POST",
        params
      ),

    addUserPost: (params: LicenseApiTypes["addUserPost"]["params"]) =>
      makeRequest<LicenseApiTypes["addUserPost"]["response"]>(
        "instances/add-user/post",
        "POST",
        params
      ),

    getUser: (params: LicenseApiTypes["getUser"]["params"]) =>
      makeRequest<LicenseApiTypes["getUser"]["response"]>(
        "instances/user",
        "GET",
        params
      ),

    workspace: (params: LicenseApiTypes["workspace"]["params"]) =>
      makeRequest<LicenseApiTypes["workspace"]["response"]>(
        "instances/workspace",
        "POST",
        params
      ),

    workspaceAddUser: (params: LicenseApiTypes["workspaceAddUser"]["params"]) =>
      makeRequest<LicenseApiTypes["workspaceAddUser"]["response"]>(
        "instances/workspace/add-user",
        "POST",
        params
      ),

    workspaceCheckout: (
      params: LicenseApiTypes["workspaceCheckout"]["params"]
    ) =>
      makeRequest<LicenseApiTypes["workspaceCheckout"]["response"]>(
        "instances/workspace/checkout",
        "POST",
        params
      ),

    workspacePortal: (params: LicenseApiTypes["workspacePortal"]["params"]) =>
      makeRequest<LicenseApiTypes["workspacePortal"]["response"]>(
        "instances/workspace/portal",
        "POST",
        params
      ),
  };
}
