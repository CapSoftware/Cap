import { Command } from "@tauri-apps/plugin-shell";
import { Resolution } from "../recording/MediaDeviceContext";

interface NetworkQualityResponse {
  base_rtt: number;
  dl_bytes_transferred: number;
  dl_flows: number;
  dl_throughput: number;
  end_date: string;
  il_h2_req_resp: number[];
  il_tcp_handshake_443: number[];
  il_tls_handshake: number[];
  interface_name: string;
  lud_foreign_h2_req_resp: number[];
  lud_foreign_tcp_handshake_443: number[];
  lud_foreign_tls_handshake: number[];
  lud_self_h2_req_resp: number[];
  os_version: string;
  other: Other;
  responsiveness: number;
  start_date: string;
  test_endpoint: string;
  ul_bytes_transferred: number;
  ul_flows: number;
  ul_throughput: number;
}

interface Other {
  ecn_values: Ecn_values;
  l4s_enablement: L4s_enablement;
  protocols_seen: Protocols_seen;
  proxy_state: Proxy_state;
}

interface Ecn_values {
  ecn_disabled: number;
}

interface L4s_enablement {
  disabled: number;
}

interface Protocols_seen {
  h2: number;
}

interface Proxy_state {
  not_proxied: number;
}

export interface NetworkQualityDetails {
  quality: string;
  color: string;
  resolution: Resolution;
}

const NETWORK_SPEED_KEY = "networkSpeedMbps";

const runNetworkQuality = async (): Promise<NetworkQualityResponse> => {
  try {
    console.time("networkQuality");
    const output = await Command.create("networkQuality", "-c").execute();
    console.timeEnd("networkQuality");
    return JSON.parse(output.stdout) as NetworkQualityResponse;
  } catch (error) {
    console.error("Error running networkQuality:", error);
    throw error;
  }
};

const convertToMbps = (throughput: number): number => {
  return throughput / 1_000_000;
};

export const getUploadSpeed = (): number | undefined => {
  const cachedSpeed = localStorage.getItem(NETWORK_SPEED_KEY);
  if (!cachedSpeed) return;
  return Number(cachedSpeed);
};

export const runSpeedTest = async () => {
  const response = await runNetworkQuality();
  const uploadMbps = convertToMbps(response.ul_throughput);
  localStorage.setItem(NETWORK_SPEED_KEY, uploadMbps.toString());
  return uploadMbps;
};

export const getNetworkQualityDetails = (
  uploadMbps: number | undefined
): NetworkQualityDetails => {
  if (uploadMbps === undefined) {
    return { quality: "Checking", color: "bg-gray-300", resolution: "Captured" };
  }

  const qualityLevels: [number, NetworkQualityDetails][] = [
    [1, { quality: "Poor", color: "bg-red-500", resolution: "720p" }],
    [5, { quality: "Fair", color: "bg-yellow-500", resolution: "720p" }],
    [15, { quality: "Good", color: "bg-green-500", resolution: "1440p" }],
  ];

  return (
    qualityLevels.find(([threshold]) => uploadMbps < threshold)?.[1] || {
      quality: "Excellent",
      color: "bg-blue-500",
      resolution: "Captured",
    }
  );
};
