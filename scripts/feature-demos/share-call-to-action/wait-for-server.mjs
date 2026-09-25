import { demoVideoId } from "./fixture.mjs";

const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const deadline = Date.now() + 170_000;

async function reachable(path) {
	try {
		const response = await fetch(`${base}${path}`, {
			redirect: "manual",
			signal: AbortSignal.timeout(60_000),
		});
		return response.status < 500;
	} catch {
		return false;
	}
}

for (const path of ["/", `/s/${demoVideoId}`]) {
	while (!(await reachable(path))) {
		if (Date.now() > deadline) throw new Error(`${path} did not become ready`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	console.log(`${path} ready`);
}
