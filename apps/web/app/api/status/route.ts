export const revalidate = 0;

export async function GET() {
	return new Response("OK", {
		status: 200,
	});
}
