import { OTLPHttpJsonTraceExporter, registerOTel } from "@vercel/otel";

export async function register() {
	if (process.env.NEXT_PUBLIC_AXIOM_TOKEN) {
		registerOTel({
			serviceName: "cap-web-backend",
			traceExporter: new OTLPHttpJsonTraceExporter({
				url: "https://api.axiom.co/v1/traces",
				headers: {
					Authorization: `Bearer ${process.env.NEXT_PUBLIC_AXIOM_TOKEN}`,
					"X-Axiom-Dataset": process.env.NEXT_PUBLIC_AXIOM_DATASET,
				},
			}),
		});
	} else if (process.env.NODE_ENV === "development") {
		registerOTel({
			serviceName: "cap-web-backend",
			traceExporter: new OTLPHttpJsonTraceExporter({}),
		});
	}

	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { register } = await import("./instrumentation.node");
		await register();
	}
}
