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
  export type StartRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `stop-recording` command */
  export type StopRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `pause-recording` command */
  export type PauseRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `resume-recording` command */
  export type ResumeRecording = ExtensionPreferences & {}
  /** Preferences accessible in the `toggle-pause` command */
  export type TogglePause = ExtensionPreferences & {}
  /** Preferences accessible in the `switch-camera` command */
  export type SwitchCamera = ExtensionPreferences & {}
  /** Preferences accessible in the `switch-microphone` command */
  export type SwitchMicrophone = ExtensionPreferences & {}
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
  /** Arguments passed to the `toggle-pause` command */
  export type TogglePause = {}
  /** Arguments passed to the `switch-camera` command */
  export type SwitchCamera = {}
  /** Arguments passed to the `switch-microphone` command */
  export type SwitchMicrophone = {}
}

