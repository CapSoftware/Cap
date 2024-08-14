import { createResource, createSignal, For, Show, Suspense } from "solid-js";

import { commands } from "../utils/tauri";
import { makeInvalidated } from "../utils/events";
import { createCameraForLabel, createCameras } from "../utils/media";

export default function () {
  const cameras = createCameras();

  const [options] = makeInvalidated(
    createResource(async () => {
      const o = await commands.getRecordingOptions();
      if (o.status === "ok") return o.data;
    }),
    "recordingOptionsChanged"
  );

  const camera = createCameraForLabel(() => options()?.cameraLabel ?? "");

  // temporary
  const [isRecording, setIsRecording] = createSignal(false);

  return (
    <Suspense>
      <Show when={options()}>
        {(options) => (
          <>
            <div>
              <select
                value={camera()?.deviceId}
                onChange={(e) => {
                  const o = options();
                  const deviceId = e.target.value;
                  const label = cameras().find(
                    (c) => c.deviceId === deviceId
                  )?.label;
                  if (!label) return;

                  commands.setRecordingOptions({ ...o, cameraLabel: label });
                }}
              >
                <For each={cameras()}>
                  {(camera) => (
                    <option value={camera.deviceId}>{camera.label}</option>
                  )}
                </For>
              </select>
              {options().cameraLabel && (
                <button
                  type="button"
                  onClick={() =>
                    commands.setRecordingOptions({
                      ...options,
                      cameraLabel: null,
                    })
                  }
                >
                  Remove
                </button>
              )}
              {camera() && (
                <div>
                  {!isRecording() ? (
                    <button
                      type="button"
                      onClick={() =>
                        commands
                          .startRecording()
                          .then(() => setIsRecording(true))
                      }
                    >
                      Start Recording
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        commands
                          .stopRecording()
                          .then(() => setIsRecording(false))
                      }
                    >
                      Stop Recording
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </Show>
    </Suspense>
  );
}

// <key>CFBundleDocumentTypes</key>
//  <array>
//      <dict>
//          <key>CFBundleDocumentTypes</key>
//          <array>
//              <dict>
//                  <key>CFBundleTypeName</key>
//                  <string>LSTypeIsPackage</string>
//                  <key>LSHandlerRank</key>
//                  <string>Default</string>
//              </dict>
//          </array>
//          <key>CFBundleTypeExtensions</key>
//          <array>
//              <string>cap</string>
//          </array>
//          <key>CFBundleTypeName</key>
//          <string>Unique Extension</string>
//          <key>CFBundleTypeRole</key>
//          <string>Editor</string>
//          <key>LSHandlerRank</key>
//          <string>Default</string>
//          <key>LSItemContentTypes</key>
//          <array>
//              <string>so.cap.recording</string>
//          </array>
//          <key>NSDocumentClass</key>
//          <string>$(PRODUCT_MODULE_NAME).Document</string>
//      </dict>
//      <dict/>
//  </array>
//  <key>UTExportedTypeDeclarations</key>
//  <array>
//      <dict>
//          <key>UTTypeConformsTo</key>
//          <array>
//              <string>com.apple.package</string>
//              <string>public.composite-content</string>
//          </array>
//          <key>UTTypeDescription</key>
//          <string>Unique Extension</string>
//          <key>UTTypeIcons</key>
//          <dict/>
//          <key>UTTypeIdentifier</key>
//          <string>com.buddhiman.Unique-Extension</string>
//          <key>UTTypeTagSpecification</key>
//          <dict>
//              <key>public.filename-extension</key>
//              <array>
//                  <string>cap</string>
//              </array>
//          </dict>
//      </dict>
//  </array>
