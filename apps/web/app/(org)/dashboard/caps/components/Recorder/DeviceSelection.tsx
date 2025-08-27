"use client";

import { Camera, Mic, Volume2 } from "lucide-react";

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
        px-2 py-0.5 rounded-full text-white text-[11px] whitespace-nowrap
        ${variant === "blue" ? "bg-blue-9" : "bg-red-9"}
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
    if (deviceId === '') {
      onSelect(null);
    } else {
      const device = devices.find(d => d.deviceId === deviceId);
      onSelect(device || null);
    }
  };

  if (!permissionGranted) {
    return (
      <div className="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg bg-gray-3">
        <Icon className="text-gray-10 size-4" />
        <span className="flex-1 text-sm text-left text-gray-11">{label}</span>
        <InfoPill variant="red" onClick={onRequestPermission}>
          Grant Permission
        </InfoPill>
      </div>
    );
  }

  return (
    <div className="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg bg-gray-3">
      <Icon className="text-gray-10 size-4" />
      <select
        value={selectedDevice?.deviceId || ''}
        onChange={handleSelectChange}
        disabled={disabled}
        className="flex-1 text-sm bg-transparent border-none outline-none text-gray-12 cursor-pointer"
      >
        <option value="">No {label}</option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
      <InfoPill variant={selectedDevice ? "blue" : "red"}>
        {selectedDevice ? "On" : "Off"}
      </InfoPill>
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
    <div className="space-y-2 px-3">
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

      <button
        type="button"
        onClick={() => onSystemAudioToggle(!isSystemAudioEnabled)}
        className="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg transition-colors bg-gray-3 disabled:text-gray-11 hover:bg-gray-4"
        disabled={disabled}
      >
        <Volume2 className="text-gray-10 size-4" />
        <p className="flex-1 text-sm text-left truncate">
          {isSystemAudioEnabled
            ? "Record System Audio"
            : "No System Audio"}
        </p>
        <InfoPill variant={isSystemAudioEnabled ? "blue" : "red"}>
          {isSystemAudioEnabled ? "On" : "Off"}
        </InfoPill>
      </button>
    </div>
  );
}