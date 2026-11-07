import { describe, expect, it } from "vitest"
import {
    buildStartRecordingDeepLink,
    buildStartRecordingPayload,
    buildStopRecordingDeepLink,
    extractShareableCapUrl,
    resolveDashboardUrl,
} from "./deeplink"

describe("Cap Raycast deep-link builders", () => {
    it("constructs start_recording payloads compatible with DeepLinkAction serde format", () => {
        const payload = buildStartRecordingPayload({
            defaultMode: "studio",
            defaultScreen: "Built-in Retina Display",
            cameraDeviceId: "cam-01",
            micLabel: "Studio Mic",
            captureSystemAudio: false,
        })

        expect(payload).toEqual({
            start_recording: {
                capture_mode: { screen: "Built-in Retina Display" },
                camera: { DeviceID: "cam-01" },
                mic_label: "Studio Mic",
                capture_system_audio: false,
                mode: "studio",
            },
        })

        const url = new URL(buildStartRecordingDeepLink(payload.start_recording as any))
        expect(url.protocol).toBe("cap-desktop:")
        expect(url.host).toBe("action")
        const decoded = JSON.parse(url.searchParams.get("value") || "{}")
        expect(decoded.start_recording.mode).toBe("instant")
    })

    it("encodes stop_recording and resolves dashboard and share URLs", () => {
        const stopUrl = new URL(buildStopRecordingDeepLink())
        expect(stopUrl.searchParams.get("value")).toBe("\"stop_recording\"")

        expect(resolveDashboardUrl()).toBe("https://cap.so/dashboard")
        expect(resolveDashboardUrl("https://cap.internal.local/dashboard/")).toBe(
            "https://cap.internal.local/dashboard"
        )

        expect(
            extractShareableCapUrl("https://cap.so/s/abc123xyz")
        ).toBe("https://cap.so/s/abc123xyz")
        expect(extractShareableCapUrl("not a link")).toBeNull()
    })
})
