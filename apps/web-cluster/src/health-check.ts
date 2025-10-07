async function checkHealth(): Promise<boolean> {
	try {
		const response = await fetch(
			`http://127.0.0.1:${process.env.HEALTH_CHECK_PORT}/health`,
		);
		return response.status === 200;
	} catch (error) {
		console.error("Health check failed:", error);
		return false;
	}
}

// Run the health check
checkHealth()
	.then((isHealthy) => {
		if (isHealthy) {
			console.log("✅ Service is healthy (200 OK)");
			process.exit(0);
		} else {
			console.log("❌ Service is not healthy (non-200 response)");
			process.exit(1);
		}
	})
	.catch((error) => {
		console.error("❌ Health check failed:", error);
		process.exit(1);
	});
