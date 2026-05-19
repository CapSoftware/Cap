import assert from "node:assert/strict";
import { buildDeviceItemsFromSystemProfiler } from "../src/lib/devices.js";

const items = buildDeviceItemsFromSystemProfiler({
	microphones: {
		SPAudioDataType: [
			{
				_name: "Studio Display Microphone",
				coreaudio_input_source: "spaudio_yes",
			},
			{
				_name: "Built-in Output",
				coreaudio_output_source: "spaudio_yes",
			},
		],
	},
	cameras: {
		SPCameraDataType: [
			{
				_name: "Studio Display Camera",
				model_id: "1452:3466",
				unique_id: "camera-unique-id",
			},
			{
				_name: "USB Camera",
				device_id: "usb-camera-id",
			},
			{
				_name: "Label Only Camera",
			},
			{
				_name: "Firmware Metadata",
				firmware_version: "abcd:1234",
			},
		],
	},
});

assert.equal(
	items.find((item) => item.key === "microphone:Studio Display Microphone")
		?.url,
	"cap-desktop://device/microphone?label=Studio%20Display%20Microphone",
);
assert.equal(
	items.find((item) => item.title === "Studio Display Camera")?.url,
	"cap-desktop://device/camera?model_id=1452%3A3466",
);
assert.equal(
	items.find((item) => item.title === "USB Camera")?.url,
	"cap-desktop://device/camera?device_id=usb-camera-id",
);
assert.equal(
	items.find((item) => item.title === "Label Only Camera")?.url,
	"cap-desktop://device/camera?label=Label%20Only%20Camera",
);
assert.equal(
	items.some((item) => item.title === "Firmware Metadata"),
	false,
);
assert.equal(
	items.find((item) => item.key === "microphone-off")?.url,
	"cap-desktop://device/microphone?off=true",
);
assert.equal(
	items.find((item) => item.key === "camera-off")?.url,
	"cap-desktop://device/camera?off=true",
);

console.log(
	JSON.stringify({
		itemCount: items.length,
		urls: items.map((item) => item.url),
	}),
);
