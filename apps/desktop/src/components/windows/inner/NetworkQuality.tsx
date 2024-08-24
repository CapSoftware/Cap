import { useEffect, useState } from "react";
import {
  getNetworkQualityDetails,
  getUploadSpeed,
  runSpeedTest,
  NetworkQualityDetails,
} from "@/utils/network/utils";
import { emit } from "@tauri-apps/api/event";
import { ArrowDown } from "@/components/icons/ArrowDown";
import {
  Resolution,
  useMediaDevices,
} from "@/utils/recording/MediaDeviceContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cap/ui";
export const NetworkQuality = () => {
  const [networkInfo, setNetworkInfo] = useState<NetworkQualityDetails>(() => {
    const initialSpeed = getUploadSpeed();
    return getNetworkQualityDetails(initialSpeed);
  });
  const [isOpen, setIsOpen] = useState(false);

  const { selectedResolution } = useMediaDevices();

  useEffect(() => {
    runSpeedTest().then((uploadMbps) => {
      const newNetworkInfo = getNetworkQualityDetails(uploadMbps);
      setNetworkInfo(newNetworkInfo);
      emit("cap://av/set-resolution", {
        resolution: newNetworkInfo.resolution,
      }).catch((error) =>
        console.log("Failed to emit cap://av/set-resolution event:", error)
      );
    });
  }, []);

  return (
    <div className="flex justify-between w-full">
      <div className="flex items-center space-x-1">
        <div className={`size-[10px] rounded-full ${networkInfo.color}`} />
        <span className="text-xs text-black">
          {networkInfo.quality === "Checking"
            ? "Running speed check"
            : `${networkInfo.quality} Upload Speed`}
        </span>
      </div>
      <div className="relative">
        <DropdownMenu
          onOpenChange={(open) => {
            setIsOpen(open);
          }}
        >
          <DropdownMenuTrigger className="w-full flex items-center justify-between">
            <span className="text-xs font-medium mr-1">
              {selectedResolution}
            </span>
            <ArrowDown className={`${isOpen ? "transform rotate-180" : ""}`} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {Object.values(Resolution).map((resolution) => (
              <DropdownMenuItem
                onSelect={() => {
                  emit("cap://av/set-resolution", {
                    resolution: resolution,
                  }).catch((error) =>
                    console.log(
                      "Failed to emit cap://av/set-resolution event:",
                      error
                    )
                  );
                }}
              >
                {resolution}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
