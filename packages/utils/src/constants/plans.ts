export const getProPlanId = () => {
  if (process.env.NEXT_PUBLIC_ENVIRONMENT === "development") {
    return "price_1P9C1DFJxA1XpeSsTwwuddnq";
  } else if (process.env.NEXT_PUBLIC_ENVIRONMENT === "production") {
    return "price_1OtBMeFJxA1XpeSsfOu2SKp1";
  } else {
    return "";
  }
};
