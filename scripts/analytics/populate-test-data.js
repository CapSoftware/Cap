import mysql from "mysql2/promise";
import { createTinybirdClient, resolveTinybirdAuth } from "./shared.js";

const TB_DATASOURCE = "analytics_events";
const MAX_VIEWS = 100;
const INGEST_CHUNK_SIZE = 5000;

const BROWSERS = ["Chrome", "Safari", "Firefox", "Edge", "Mobile Safari", "Samsung Internet"];
const DEVICES = ["Desktop", "Mobile", "Tablet"];
const OS_OPTIONS = ["Mac OS", "Windows", "iOS", "Android", "Linux"];

const CITIES = [
	{ name: "New York", country: "United States", region: "New York" },
	{ name: "Los Angeles", country: "United States", region: "California" },
	{ name: "Chicago", country: "United States", region: "Illinois" },
	{ name: "London", country: "United Kingdom", region: "England" },
	{ name: "Toronto", country: "Canada", region: "Ontario" },
	{ name: "Berlin", country: "Germany", region: "Berlin" },
	{ name: "Paris", country: "France", region: "Île-de-France" },
	{ name: "Sydney", country: "Australia", region: "New South Wales" },
	{ name: "Tokyo", country: "Japan", region: "Tokyo" },
	{ name: "São Paulo", country: "Brazil", region: "São Paulo" },
	{ name: "Mumbai", country: "India", region: "Maharashtra" },
	{ name: "Prague", country: "Czech Republic", region: "Praha" },
	{ name: "Silver Spring", country: "United States", region: "Maryland" },
	{ name: "Ashburn", country: "United States", region: "Virginia" },
];

function randomChoice(array) {
	return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRandomTimestamp(daysAgo = 30) {
	const now = Date.now();
	const daysAgoMs = daysAgo * 24 * 60 * 60 * 1000;
	const randomMs = Math.random() * daysAgoMs;
	const timestamp = new Date(now - randomMs);
	return timestamp.toISOString();
}

function generateSessionId(videoId, timestamp, city, browser, index) {
	const day = timestamp.slice(0, 10);
	return `test:${videoId}:${day}:${city}:${browser}-${index}`;
}

function generateTestEvent(videoId, orgId = "", index = 0) {
	const timestamp = generateRandomTimestamp(30);
	const city = randomChoice(CITIES);
	const browser = randomChoice(BROWSERS);
	const device = randomChoice(DEVICES);
	const os = randomChoice(OS_OPTIONS);
	const sessionId = generateSessionId(videoId, timestamp, city.name, browser, index);

	return {
		timestamp,
		session_id: sessionId,
		tenant_id: orgId,
		action: "page_hit",
		version: "test_data_v1",
		pathname: `/s/${videoId}`,
		video_id: videoId,
		country: city.country,
		region: city.region,
		city: city.name,
		browser,
		device,
		os,
	};
}

function toNdjson(rows) {
	return rows.map((r) => JSON.stringify(r)).join("\n");
}

async function tinybirdIngest({ host, token, datasource, ndjson }) {
	const search = new URLSearchParams({ name: datasource, format: "ndjson" });
	const url = `${host.replace(/\/$/, "")}/v0/events?${search.toString()}`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/x-ndjson",
			Accept: "application/json",
		},
		body: ndjson,
	});
	const text = await response.text();
	if (!response.ok) {
		let message = text;
		try {
			const payload = JSON.parse(text || "{}");
			message = payload?.error || payload?.message || text;
		} catch {}
		throw new Error(`Tinybird ingest failed (${response.status}): ${message}`);
	}
	return text ? JSON.parse(text) : {};
}

function parseDatabaseUrl(url) {
	if (!url) throw new Error("DATABASE_URL not found");
	if (!url.startsWith("mysql://")) throw new Error("DATABASE_URL is not a MySQL URL");

	const parsed = new URL(url);
	const config = {
		host: parsed.hostname,
		port: parsed.port ? parseInt(parsed.port, 10) : 3306,
		user: parsed.username,
		password: parsed.password,
		database: parsed.pathname.slice(1),
		ssl: {
			rejectUnauthorized: false,
		},
	};

	return config;
}

async function getVideoIds() {
	const dbUrl = process.env.DATABASE_URL;
	if (!dbUrl) {
		throw new Error("DATABASE_URL environment variable is required");
	}

	const config = parseDatabaseUrl(dbUrl);
	const connection = await mysql.createConnection(config);

	try {
		const [rows] = await connection.execute(
			"SELECT id, orgId FROM videos LIMIT 1000",
		);

		const videoIds = rows.map((r) => r.id);
		const orgMap = new Map();
		for (const row of rows) {
			orgMap.set(row.id, row.orgId || "");
		}

		return { videoIds, orgMap };
	} finally {
		await connection.end();
	}
}

function distributeViews(videoIds, totalViews) {
	if (videoIds.length === 0) return [];
	if (videoIds.length === 1) return [{ videoId: videoIds[0], views: totalViews }];

	const distribution = [];
	let remaining = totalViews;

	for (let i = 0; i < videoIds.length - 1; i++) {
		const maxForThis = Math.floor(remaining / (videoIds.length - i));
		const views = randomInt(1, Math.max(1, Math.min(maxForThis, remaining - (videoIds.length - i - 1))));
		distribution.push({ videoId: videoIds[i], views });
		remaining -= views;
	}

	if (remaining > 0) {
		distribution.push({ videoId: videoIds[videoIds.length - 1], views: remaining });
	} else {
		distribution.push({ videoId: videoIds[videoIds.length - 1], views: 1 });
	}

	return distribution;
}

async function main() {
	console.log("Fetching video IDs from database...");
	const { videoIds, orgMap } = await getVideoIds();

	if (videoIds.length === 0) {
		console.error("No video IDs found in database");
		process.exit(1);
	}

	console.log(`Found ${videoIds.length} video(s)`);

	const distribution = distributeViews(videoIds, MAX_VIEWS);
	console.log(`Generating ${MAX_VIEWS} test views across ${distribution.length} video(s)...`);

	const events = [];
	for (const { videoId, views } of distribution) {
		const orgId = orgMap.get(videoId) || "";
		for (let i = 0; i < views; i++) {
			events.push(generateTestEvent(videoId, orgId, i));
		}
	}

	console.log(`Generated ${events.length} events`);

	const auth = resolveTinybirdAuth();
	const client = createTinybirdClient(auth);

	console.log(`Ingesting events into Tinybird (${auth.host})...`);

	let totalWritten = 0;
	const chunks = [];
	for (let i = 0; i < events.length; i += INGEST_CHUNK_SIZE) {
		chunks.push(events.slice(i, i + INGEST_CHUNK_SIZE));
	}

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const ndjson = toNdjson(chunk);
		await tinybirdIngest({
			host: client.host,
			token: client.token,
			datasource: TB_DATASOURCE,
			ndjson,
		});
		totalWritten += chunk.length;
		console.log(`Ingested chunk ${i + 1}/${chunks.length} (${chunk.length} events)`);
	}

	console.log(`\n✅ Successfully ingested ${totalWritten} events into Tinybird`);
	console.log(`\nSummary:`);
	console.log(`  Videos: ${distribution.length}`);
	console.log(`  Total events: ${totalWritten}`);
	console.log(`  Distribution:`);
	for (const { videoId, views } of distribution) {
		console.log(`    ${videoId}: ${views} views`);
	}
}

main().catch((err) => {
	console.error("Error:", err);
	process.exit(1);
});

