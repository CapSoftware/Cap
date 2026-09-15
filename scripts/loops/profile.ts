import { customerCopy } from "../../emails/customer-copy";
import {
	classifyProfile as classify,
	type ProfileInput,
} from "../../packages/database/loops/profile";

export * from "../../packages/database/loops/profile";
export const classifyProfile = (input: ProfileInput) =>
	classify(input, customerCopy);
