const encodeRfc5987 = (value: string) =>
	encodeURIComponent(value).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

const isUnsafeFileNameChar = (char: string) => {
	const code = char.charCodeAt(0);
	return code < 0x20 || code === 0x7f || char === "/" || char === "\\";
};

export const attachmentContentDisposition = (fileName: string) => {
	const name = Array.from(fileName, (char) =>
		isUnsafeFileNameChar(char) ? "_" : char,
	)
		.join("")
		.trim();
	const safeName = name.length > 0 ? name : "download";
	const asciiName = safeName.replace(/[^\x20-\x7e]|"/g, "_");
	return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(safeName)}`;
};
