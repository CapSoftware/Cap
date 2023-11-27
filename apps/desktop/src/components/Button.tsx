export const Button = ({
  variant,
  handler,
  label,
}: {
  handler: () => void;
  label: string;
  variant: "primary" | "secondary" | "tertiary" | "white";
}) => {
  const variantClasses = {
    primary: "bg-primary hover:bg-primary-2 text-white border-secondary",
    secondary: "bg-secondary hover:bg-secondary-2 text-white",
    tertiary: "bg-transparent text-black",
    white: "bg-white text-black",
  };

  return (
    <div>
      <button
        onClick={handler}
        className={`${variantClasses[variant]} w-full border-2 h-[50px] text-center py-2 px-4 bg-gray-200 font-medium flex items-center justify-center rounded-[15px] transition-all`}
      >
        {label}
      </button>
    </div>
  );
};
