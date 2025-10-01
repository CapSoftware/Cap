export interface Author {
	name: string;
	handle: string;
	image: string;
}

export const AUTHORS: Record<string, Author> = {
	"Richie McIlroy": {
		name: "Richie McIlroy",
		handle: "richiemcilroy",
		image: "/blog/author/richiemcilroy.jpg",
	},
	"Brendan Allan": {
		name: "Brendan Allan",
		handle: "brendonovichdev",
		image: "/blog/author/brendonovichdev.jpg",
	},
};

export function getAuthor(name: string): Author | undefined {
	return AUTHORS[name];
}

export function parseAuthors(authorString: string): Author[] {
	return authorString
		.split(",")
		.map((name) => name.trim())
		.map((name) => getAuthor(name))
		.filter((author): author is Author => author !== undefined);
}
