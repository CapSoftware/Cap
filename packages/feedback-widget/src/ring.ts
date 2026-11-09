export class Ring<T> {
	private items: T[] = [];

	constructor(private readonly limit: number) {}

	push(item: T): void {
		this.items.push(item);
		if (this.items.length > this.limit)
			this.items.splice(0, this.items.length - this.limit);
	}

	values(): T[] {
		return [...this.items];
	}

	get size(): number {
		return this.items.length;
	}
}
