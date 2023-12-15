export const Button = ({
  variant,
  handler,
  label,
  className,
}: {
  handler: () => void;
  label: string;
  variant: "primary" | "secondary" | "tertiary" | "white";
  className?: string;
}) => {
  let classes =
    "w-full border-2 min-h-[50px] text-center py-2 px-4 bg-gray-200 font-medium flex items-center justify-center rounded-[15px] transition-all";
  const variantClasses = {
    primary: "bg-primary hover:bg-primary-2 text-white border-secondary",
    secondary: "bg-secondary hover:bg-secondary-2 text-white",
    tertiary: "bg-transparent text-black",
    white: "bg-white text-black",
  };

  classes = `${classes} ${variantClasses[variant]}`;

  if (className) {
    classes = `${classes} ${className}`;
  }

  return (
    <button onClick={handler} className={classes}>
      {label}
    </button>
  );
};
