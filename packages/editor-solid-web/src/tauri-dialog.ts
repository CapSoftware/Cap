import {
	CAP_BUNDLE_CONTENT_TYPE,
	createCapBundle,
	validCapBundlePath,
} from "@cap/editor-cap-bundle";

type OpenOptions = {
	filters?: Array<{ extensions: string[] }>;
	multiple?: boolean;
	directory?: boolean;
};

const selectedFiles = new Map<string, File>();

export function takeEditorSelectedFile(path: string) {
	const file = selectedFiles.get(path) ?? null;
	selectedFiles.delete(path);
	return file;
}

export function bundleEditorCapDirectory(files: readonly File[]) {
	if (files.length < 2) {
		throw new Error("Select a Cap recording folder with its media files");
	}
	const sourceName = files[0]?.webkitRelativePath.split("/")[0];
	if (!sourceName || !/\.cap$/i.test(sourceName)) {
		throw new Error("Select a .cap recording folder");
	}
	const sources: Array<{ path: string; file: File }> = [];
	for (const file of files) {
		const [root, ...parts] = file.webkitRelativePath.split("/");
		if (root !== sourceName || parts.length === 0) {
			throw new Error("Cap recording contains files from another folder");
		}
		const path = parts.join("/");
		if (validCapBundlePath(path)) sources.push({ path, file });
	}
	if (
		!sources.some((source) => source.path === "recording-meta.json") ||
		!sources.some(
			(source) =>
				source.path.startsWith("content/") || source.path.startsWith("output/"),
		)
	) {
		throw new Error("Selected folder is missing Cap recording media");
	}
	return new File(
		[createCapBundle(sources)],
		`${sourceName.slice(0, -4)}.capbundle`,
		{
			type: CAP_BUNDLE_CONTENT_TYPE,
		},
	);
}

function openCapDirectory(): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.hidden = true;
		input.setAttribute("webkitdirectory", "");
		input.setAttribute("directory", "");
		let finished = false;
		const finish = (value: string | null) => {
			if (finished) return;
			finished = true;
			input.remove();
			resolve(value);
		};
		input.addEventListener("change", () => {
			try {
				const file = bundleEditorCapDirectory(Array.from(input.files ?? []));
				const token = `cap-web-editor://import/${crypto.randomUUID()}`;
				selectedFiles.set(token, file);
				window.setTimeout(() => selectedFiles.delete(token), 60_000);
				finish(token);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Cap recording could not be opened";
				finish(null);
				window.setTimeout(() => window.alert(message), 0);
			}
		});
		input.addEventListener("cancel", () => finish(null));
		document.body.append(input);
		input.click();
	});
}

export function open(options?: OpenOptions): Promise<string | null> {
	if (
		options?.directory ||
		options?.filters?.some((filter) =>
			filter.extensions.some(
				(extension) => extension.replace(/^\./, "") === "cap",
			),
		)
	) {
		return openCapDirectory();
	}
	if (options?.multiple) return Promise.resolve(null);
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.hidden = true;
		input.accept =
			options?.filters
				?.flatMap((filter) => filter.extensions)
				.map((extension) => `.${extension.replace(/^\./, "")}`)
				.join(",") ?? "";
		let finished = false;
		const finish = (value: string | null) => {
			if (finished) return;
			finished = true;
			input.remove();
			resolve(value);
		};
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				finish(null);
				return;
			}
			const token = `cap-web-editor://import/${crypto.randomUUID()}`;
			selectedFiles.set(token, file);
			window.setTimeout(() => selectedFiles.delete(token), 60_000);
			finish(token);
		});
		input.addEventListener("cancel", () => finish(null));
		document.body.append(input);
		input.click();
	});
}

export function ask(message: string): Promise<boolean> {
	return Promise.resolve(window.confirm(message));
}

export function confirm(message: string): Promise<boolean> {
	return Promise.resolve(window.confirm(message));
}

type MessageOptions =
	| string
	| {
			title?: string;
			buttons?:
				| "Ok"
				| "OkCancel"
				| "YesNo"
				| "YesNoCancel"
				| {
						ok?: string;
						yes?: string;
						no?: string;
						cancel?: string;
				  };
	  };

function messageButtons(options?: MessageOptions) {
	const buttons = typeof options === "string" ? "Ok" : options?.buttons;
	if (typeof buttons === "object") return Object.values(buttons);
	if (buttons === "OkCancel") return ["Ok", "Cancel"];
	if (buttons === "YesNo") return ["Yes", "No"];
	if (buttons === "YesNoCancel") return ["Yes", "No", "Cancel"];
	return ["Ok"];
}

export function message(
	text: string,
	options?: MessageOptions,
): Promise<string> {
	const buttons = messageButtons(options);
	const title = typeof options === "string" ? options : options?.title;
	return new Promise((resolve) => {
		const dialog = document.createElement("dialog");
		if (title) {
			const heading = document.createElement("strong");
			heading.textContent = title;
			dialog.append(heading);
		}
		const body = document.createElement("p");
		body.textContent = text;
		dialog.append(body);
		const actions = document.createElement("div");
		for (const label of buttons) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			button.addEventListener("click", () => {
				dialog.close();
				dialog.remove();
				resolve(label);
			});
			actions.append(button);
		}
		dialog.addEventListener("cancel", () => {
			dialog.remove();
			resolve(buttons.includes("Cancel") ? "Cancel" : buttons.at(-1) || "Ok");
		});
		dialog.append(actions);
		document.body.append(dialog);
		dialog.showModal();
	});
}
