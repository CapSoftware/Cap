// import { mutationOptions } from "@tanstack/react-query";

import { MutationOptions } from "@tanstack/react-query";

// const todo = mutationOptions({});

const todo = {
	mutationKey: ["todo"],
	mutationFn: async (data: any) => {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		return "bruh";
	},
} satisfies MutationOptions;

export function useUploadCap() {
	// TODO
}

export function useUploadCapStatus() {
	// TODO
}
