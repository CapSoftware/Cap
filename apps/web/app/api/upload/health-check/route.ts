export interface UploadHealthCheckResponse {
    ok: boolean
    status: "healthy" | "degraded"
    bytesReceived: number
    serverTimestampMs: number
    message: string
}

const MIN_PROBE_BYTES = 16

// Validates the desktop startup screen-recording upload probe payload and returns diagnostic telemetry.
export async function POST(request: Request): Promise<Response> {
    try {
        const buffer = await request.arrayBuffer()
        const bytesReceived = buffer.byteLength

        if (bytesReceived < MIN_PROBE_BYTES) {
            const degraded: UploadHealthCheckResponse = {
                ok: false,
                status: "degraded",
                bytesReceived,
                serverTimestampMs: Date.now(),
                message:
                    "Upload probe payload is too small — please contact support.",
            }
            return Response.json(degraded, { status: 400 })
        }

        const healthy: UploadHealthCheckResponse = {
            ok: true,
            status: "healthy",
            bytesReceived,
            serverTimestampMs: Date.now(),
            message: "Upload health check succeeded.",
        }
        return Response.json(healthy, { status: 200 })
    } catch {
        const failed: UploadHealthCheckResponse = {
            ok: false,
            status: "degraded",
            bytesReceived: 0,
            serverTimestampMs: Date.now(),
            message:
                "Upload health check failed — please contact support if recording uploads fail.",
        }
        return Response.json(failed, { status: 500 })
    }
}

// Responds to lightweight GET readiness checks from the Cap desktop client.
export async function GET(): Promise<Response> {
    const body: UploadHealthCheckResponse = {
        ok: true,
        status: "healthy",
        bytesReceived: 0,
        serverTimestampMs: Date.now(),
        message: "Upload health-check endpoint ready.",
    }
    return Response.json(body, { status: 200 })
}
