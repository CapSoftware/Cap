import { serverEnv } from "@cap/env";
import { createConnection, type RowDataPacket } from "mysql2/promise";

let activeConnections = 0;

export async function getLicenseCustomerIds(email: string) {
	const uri = serverEnv().LICENSE_DATABASE_URL;
	if (!uri) throw new Error("License billing is unavailable.");
	if (activeConnections >= 4)
		throw new Error("License billing is busy. Try again shortly.");
	activeConnections++;
	let connection: Awaited<ReturnType<typeof createConnection>> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		connection = await createConnection({
			uri,
			ssl: { rejectUnauthorized: true },
			connectTimeout: 5_000,
		});
		const query = connection.execute<(RowDataPacket & { stripeId: string })[]>(
			`SELECT DISTINCT sc.stripeId
			FROM stripeCustomers sc JOIN user u ON u.id = sc.userId
			WHERE u.email = ?
			AND NOT EXISTS (
				SELECT 1 FROM stripeCustomers other
				WHERE other.stripeId = sc.stripeId AND other.userId <> sc.userId
			)`,
			[email],
		);
		const [rows] = await Promise.race([
			query,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("License billing lookup timed out.")),
					5_000,
				);
			}),
		]);
		return rows.map((row) => row.stripeId);
	} finally {
		clearTimeout(timeout);
		activeConnections--;
		connection?.destroy();
	}
}
