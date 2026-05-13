/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `start-recording` command */
  export type StartRecording = ExtensionPreferences & {
  /** Default Screen Name - Screen display name used by Start Recording when Capture Source is Screen. */
  "defaultScreenName"?: string,
  /** Default Window Name - Window title used by Start Recording when Capture Source is Window. */
  "defaultWindowName"?: string,
  /** Microphone Label - Microphone label Cap should select before recording. */
  "microphoneLabel"?: string,
  /** Camera Device ID - Camera device ID Cap should select before recording. */
  "cameraDeviceId"?: string,
  /** Recording Mode - Default Cap recording mode. */
  "recordingMode": "studio" | "instant" | "screenshot",
  /** Capture System Audio - Capture system audio by default. */
  "captureSystemAudio": boolean
}
  /** Preferences accessible in the `stop-recording` command */
  export type StopRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `pause-recording` command */
  export type PauseRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `resume-recording` command */
  export type ResumeRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `switch-microphone` command */
  export type SwitchMicrophone = ExtensionPreferences & {
  /** Default Screen Name - Screen display name used by Start Recording when Capture Source is Screen. */
  "defaultScreenName"?: string,
  /** Default Window Name - Window title used by Start Recording when Capture Source is Window. */
  "defaultWindowName"?: string,
  /** Microphone Label - Microphone label Cap should select before recording. */
  "microphoneLabel"?: string,
  /** Camera Device ID - Camera device ID Cap should select before recording. */
  "cameraDeviceId"?: string,
  /** Recording Mode - Default Cap recording mode. */
  "recordingMode": "studio" | "instant" | "screenshot",
  /** Capture System Audio - Capture system audio by default. */
  "captureSystemAudio": boolean
}
  /** Preferences accessible in the `switch-camera` command */
  export type SwitchCamera = ExtensionPreferences & {
  /** Default Screen Name - Screen display name used by Start Recording when Capture Source is Screen. */
  "defaultScreenName"?: string,
  /** Default Window Name - Window title used by Start Recording when Capture Source is Window. */
  "defaultWindowName"?: string,
  /** Microphone Label - Microphone label Cap should select before recording. */
  "microphoneLabel"?: string,
  /** Camera Device ID - Camera device ID Cap should select before recording. */
  "cameraDeviceId"?: string,
  /** Recording Mode - Default Cap recording mode. */
  "recordingMode": "studio" | "instant" | "screenshot",
  /** Capture System Audio - Capture system audio by default. */
  "captureSystemAudio": boolean
}
}

declare namespace Arguments {
  /** Arguments passed to the `start-recording` command */
  export type StartRecording = {}
  /** Arguments passed to the `stop-recording` command */
  export type StopRecording = {}
  /** Arguments passed to the `pause-recording` command */
  export type PauseRecording = {}
  /** Arguments passed to the `resume-recording` command */
  export type ResumeRecording = {}
  /** Arguments passed to the `switch-microphone` command */
  export type SwitchMicrophone = {}
  /** Arguments passed to the `switch-camera` command */
  export type SwitchCamera = {}
}

