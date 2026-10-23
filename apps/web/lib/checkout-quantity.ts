export const MAX_CHECKOUT_QUANTITY = 10000;

export const parseCheckoutQuantity = (quantity: unknown): number | null => {
	if (quantity === undefined || quantity === null) return 1;
	return typeof quantity === "number" &&
		Number.isInteger(quantity) &&
		quantity >= 1 &&
		quantity <= MAX_CHECKOUT_QUANTITY
		? quantity
		: null;
};
