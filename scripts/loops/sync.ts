import { parseArgs } from "node:util";
import { customerCopy } from "../../emails/customer-copy";
import { runLoopsSync } from "../../packages/database/loops/worker";

const { values } = parseArgs({
	options: { apply: { type: "boolean", default: false } },
});
if (!values.apply)
	throw new Error(
		"Pass --apply to process queued updates. Defaults to the owned-email allowlist; see README.md.",
	);
console.log(JSON.stringify(await runLoopsSync(customerCopy)));
