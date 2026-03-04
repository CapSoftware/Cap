import "server-only";
import { createHash } from "node:crypto";

const ANIMALS = [
	"Walrus",
	"Capybara",
	"Narwhal",
	"Quokka",
	"Axolotl",
	"Pangolin",
	"Okapi",
	"Platypus",
	"Wombat",
	"Chinchilla",
	"Manatee",
	"Flamingo",
	"Hedgehog",
	"Otter",
	"Puffin",
	"Raccoon",
	"Sloth",
	"Chameleon",
	"Penguin",
	"Koala",
	"Red Panda",
	"Seahorse",
	"Toucan",
	"Lemur",
	"Armadillo",
	"Alpaca",
	"Meerkat",
	"Ibex",
	"Tapir",
	"Kiwi",
	"Gecko",
	"Bison",
] as const;

function getSessionDigest(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}

export function getAnonymousName(sessionId: string): string {
	const digest = getSessionDigest(sessionId);
	const index = Number.parseInt(digest.slice(0, 8), 16) % ANIMALS.length;
	return `Anonymous ${ANIMALS[index]}`;
}

export function getSessionHash(sessionId: string): string {
	return getSessionDigest(sessionId);
}
