async function openShare() {
	const id = location.pathname.split("/").at(-1);
	const base = `/api/v1/shares/${id}`;
	const token = location.hash.slice(1);
	if (token) {
		const access = await fetch(`${base}/access`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			credentials: "same-origin",
		});
		if (!access.ok)
			throw new Error("This link has expired, was revoked, or is incomplete.");
	}
	const response = await fetch(`${base}/metadata`, {
		credentials: "same-origin",
	});
	if (!response.ok)
		throw new Error(
			"Open the full sharing link to view this recording. It may have expired or been revoked.",
		);
	const share = await response.json();
	document.title = document.title.replace("Shared recording", share.title);
	document.getElementById("title").textContent = share.title;
	document.getElementById("status").textContent =
		`Available until ${new Date(share.expiresAt).toLocaleString()}`;
	const element = document.getElementById(
		share.contentType === "video/mp4" ? "video" : "image",
	);
	element.src = `${base}/media`;
	element.hidden = false;
}
openShare().catch((error) => {
	document.getElementById("title").textContent = "Recording unavailable";
	document.getElementById("status").textContent = error.message;
});
