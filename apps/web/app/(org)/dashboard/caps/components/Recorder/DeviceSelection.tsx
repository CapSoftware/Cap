"use client";

import { Camera, Mic } from "lucide-react";

type MediaDevice = {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
};

type PermissionStatus = "granted" | "denied" | "prompt" | "checking";

interface DeviceSelectionProps {
  selectedCamera: MediaDevice | null;
  selectedMicrophone: MediaDevice | null;
  availableCameras: MediaDevice[];
  availableMicrophones: MediaDevice[];
  isSystemAudioEnabled: boolean;
  cameraPermission: PermissionStatus;
  micPermission: PermissionStatus;
  onCameraSelect: (device: MediaDevice | null) => void;
  onMicrophoneSelect: (device: MediaDevice | null) => void;
  onSystemAudioToggle: (enabled: boolean) => void;
  onRequestCameraPermission: () => void;
  onRequestMicPermission: () => void;
  disabled?: boolean;
}

interface InfoPillProps {
  variant: "blue" | "red";
  children: React.ReactNode;
  onClick?: () => void;
}

function InfoPill({ variant, children, onClick }: InfoPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        px-[0.375rem] rounded-full text-[0.75rem] whitespace-nowrap
        ${variant === "blue" ? "bg-blue-3 text-blue-9" : "bg-red-3 text-red-9"}
        ${onClick ? "cursor-pointer hover:opacity-90" : "cursor-default"}
      `}
    >
      {children}
    </button>
  );
}

interface DeviceSelectButtonProps {
  icon: React.ElementType;
  label: string;
  selectedDevice: MediaDevice | null;
  devices: MediaDevice[];
  onSelect: (device: MediaDevice | null) => void;
  onRequestPermission: () => void;
  permissionGranted: boolean;
  disabled?: boolean;
}

function DeviceSelectButton({
  icon: Icon,
  label,
  selectedDevice,
  devices,
  onSelect,
  onRequestPermission,
  permissionGranted,
  disabled,
}: DeviceSelectButtonProps) {
  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const deviceId = e.target.value;
    if (deviceId === "") {
      onSelect(null);
    } else {
      const device = devices.find((d) => d.deviceId === deviceId);
      onSelect(device || null);
    }
  };

  if (!permissionGranted) {
    return (
      <div className="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full">
        <Icon className="text-gray-11 size-[1.25rem]" />
        <span className="flex-1 text-left truncate">{label}</span>
        <InfoPill variant="red" onClick={onRequestPermission}>
          Request Permission
        </InfoPill>
      </div>
    );
  }

  return (
    <div className="flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border rounded-lg border-gray-3 w-full disabled:text-gray-11 transition-colors">
      <Icon className="text-gray-11 size-[1.25rem]" />
      <select
        value={selectedDevice?.deviceId || ""}
        onChange={handleSelectChange}
        disabled={disabled}
        className="flex-1 text-left truncate bg-transparent border-none outline-none text-[--text-primary] cursor-pointer"
      >
        <option value="">No {label}</option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
      {selectedDevice && <InfoPill variant="blue">On</InfoPill>}
    </div>
  );
}

export function DeviceSelection({
  selectedCamera,
  selectedMicrophone,
  availableCameras,
  availableMicrophones,
  isSystemAudioEnabled,
  cameraPermission,
  micPermission,
  onCameraSelect,
  onMicrophoneSelect,
  onSystemAudioToggle,
  onRequestCameraPermission,
  onRequestMicPermission,
  disabled,
}: DeviceSelectionProps) {
  return (
    <div className="flex flex-col gap-[0.25rem] items-stretch px-3">
      <DeviceSelectButton
        icon={Camera}
        label="Camera"
        selectedDevice={selectedCamera}
        devices={availableCameras}
        onSelect={onCameraSelect}
        onRequestPermission={onRequestCameraPermission}
        permissionGranted={cameraPermission === "granted"}
        disabled={disabled}
      />

      <DeviceSelectButton
        icon={Mic}
        label="Microphone"
        selectedDevice={selectedMicrophone}
        devices={availableMicrophones}
        onSelect={onMicrophoneSelect}
        onRequestPermission={onRequestMicPermission}
        permissionGranted={micPermission === "granted"}
        disabled={disabled}
      />
    </div>
  );
}
