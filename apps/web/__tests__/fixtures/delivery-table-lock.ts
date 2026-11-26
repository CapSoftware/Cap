import { createConnection } from "mysql2/promise";

const LOCK_NAME = "infra_delivery_daily_table";
const LOCK_WAIT_SECONDS = 120;

// The Infra database suites run in parallel against one database, and some
// of them drop and recreate developer_delivery_daily. Every file that touches
// the table holds this lock for its whole run, on its own connection so the
// lock lives exactly as long as that connection.
export const DELIVERY_TABLE_LOCK_HOOK_TIMEOUT_MS =
	(LOCK_WAIT_SECONDS + 10) * 1000;

export async function lockDeliveryTable(uri: string) {
	const connection = await createConnection({ uri });
	try {
		const [rows] = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [
			LOCK_NAME,
			LOCK_WAIT_SECONDS,
		]);
		const acquired = (rows as { acquired: number | null }[])[0]?.acquired;
		if (acquired !== 1) {
			throw new Error(
				`Another test file held the ${LOCK_NAME} lock for more than ${LOCK_WAIT_SECONDS} seconds`,
			);
		}
	} catch (error) {
		await connection.end().catch(() => {});
		throw error;
	}
	return async () => {
		try {
			await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
		} finally {
			await connection.end();
		}
	};
}
