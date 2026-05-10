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
  /** Preferences accessible in the `start-studio-recording` command */
  export type StartStudioRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `start-instant-recording` command */
  export type StartInstantRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `stop-recording` command */
  export type StopRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `restart-recording` command */
  export type RestartRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `pause-recording` command */
  export type PauseRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `resume-recording` command */
  export type ResumeRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `toggle-pause-recording` command */
  export type TogglePauseRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `open-recording-picker` command */
  export type OpenRecordingPicker = ExtensionPreferences & {}
  /** Preferences accessible in the `set-microphone` command */
  export type SetMicrophone = ExtensionPreferences & {}
  /** Preferences accessible in the `clear-microphone` command */
  export type ClearMicrophone = ExtensionPreferences & {}
  /** Preferences accessible in the `set-camera` command */
  export type SetCamera = ExtensionPreferences & {}
  /** Preferences accessible in the `clear-camera` command */
  export type ClearCamera = ExtensionPreferences & {}
  /** Preferences accessible in the `open-settings` command */
  export type OpenSettings = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `start-studio-recording` command */
  export type StartStudioRecording = {}
  /** Arguments passed to the `start-instant-recording` command */
  export type StartInstantRecording = {}
  /** Arguments passed to the `stop-recording` command */
  export type StopRecording = {}
  /** Arguments passed to the `restart-recording` command */
  export type RestartRecording = {}
  /** Arguments passed to the `pause-recording` command */
  export type PauseRecording = {}
  /** Arguments passed to the `resume-recording` command */
  export type ResumeRecording = {}
  /** Arguments passed to the `toggle-pause-recording` command */
  export type TogglePauseRecording = {}
  /** Arguments passed to the `open-recording-picker` command */
  export type OpenRecordingPicker = {}
  /** Arguments passed to the `set-microphone` command */
  export type SetMicrophone = {
  /** MacBook Pro Microphone */
  "micLabel": string
}
  /** Arguments passed to the `clear-microphone` command */
  export type ClearMicrophone = {}
  /** Arguments passed to the `set-camera` command */
  export type SetCamera = {
  /** camera-device-id */
  "deviceId": string
}
  /** Arguments passed to the `clear-camera` command */
  export type ClearCamera = {}
  /** Arguments passed to the `open-settings` command */
  export type OpenSettings = {}
}
