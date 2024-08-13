import { useEffect, useState } from "react";
import {
  getNetworkQualityDetails,
  getUploadSpeed,
  runSpeedTest,
  NetworkQualityDetails,
} from "@/utils/network/utils";

export const NetworkQuality = () => {
  const [networkInfo, setNetworkInfo] = useState<NetworkQualityDetails>(() => {
    const initialSpeed = getUploadSpeed();
    return getNetworkQualityDetails(initialSpeed);
  });

  useEffect(() => {
    runSpeedTest().then((uploadMbps) => {
      setNetworkInfo(getNetworkQualityDetails(uploadMbps));
    });
  }, []);

  return (
    <div className="flex items-center space-x-2">
      <div className={`w-2 h-2 rounded-full ${networkInfo.color}`} />
      <span className="text-xs text-gray-600">
        {networkInfo.quality === "Checking"
          ? "Running speed check"
          : `${networkInfo.quality} Upload Speed`}
      </span>
    </div>
  );
};
