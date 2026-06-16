import { describe, expect, it } from "vitest";
import base from "./base.json";
import nextjs from "./nextjs.json";
import reactLibrary from "./react-library.json";

describe("shared TypeScript configs", () => {
	it("keeps strictness enabled in the base config", () => {
		expect(base.compilerOptions.strict).toBe(true);
		expect(base.compilerOptions.forceConsistentCasingInFileNames).toBe(true);
	});

	it("extends the base config for React and Next.js presets", () => {
		expect(reactLibrary.extends).toBe("./base.json");
		expect(reactLibrary.compilerOptions.jsx).toBe("react-jsx");
		expect(nextjs.extends).toBe("./base.json");
		expect(nextjs.compilerOptions.jsx).toBe("preserve");
	});
});
