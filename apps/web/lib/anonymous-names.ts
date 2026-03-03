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

function hashSessionId(sessionId: string): number {
	let hash = 0;
	for (let i = 0; i < sessionId.length; i++) {
		const char = sessionId.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash |= 0;
	}
	return hash >>> 0;
}

export function getAnonymousName(sessionId: string): string {
	const index = hashSessionId(sessionId) % ANIMALS.length;
	return `Anonymous ${ANIMALS[index]}`;
}

export function getSessionHash(sessionId: string): string {
	return hashSessionId(sessionId).toString(36);
}
