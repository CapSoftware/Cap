function pickFiles(configure: (input: HTMLInputElement) => void) {
	return new Promise<File[] | null>((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.hidden = true;
		configure(input);
		let finished = false;
		const finish = (value: File[] | null) => {
			if (finished) return;
			finished = true;
			input.remove();
			resolve(value);
		};
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			finish(files.length > 0 ? files : null);
		});
		input.addEventListener("cancel", () => finish(null));
		document.body.append(input);
		input.click();
	});
}

export async function pickFile(extensions: readonly string[]) {
	const files = await pickFiles((input) => {
		input.accept = extensions
			.map((extension) => `.${extension.replace(/^\./, "")}`)
			.join(",");
	});
	return files?.[0] ?? null;
}

export function downloadTextFile(fileName: string, contents: string) {
	if (
		!/^[^/\\]{1,140}\.(srt|vtt)$/.test(fileName) ||
		fileName.split("").some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	) {
		throw new Error("Invalid caption download name");
	}
	const url = URL.createObjectURL(
		new Blob([contents], { type: "text/plain;charset=utf-8" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
