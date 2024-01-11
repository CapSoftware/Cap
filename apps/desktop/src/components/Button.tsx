export const Button = ({
  variant,
  handler,
  label,
  className,
  spinner,
}: {
  handler: () => void;
  label: string;
  variant: "primary" | "secondary" | "tertiary" | "white";
  className?: string;
  spinner?: boolean;
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
      {spinner && (
        <div className="ml-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-6 h-6"
            viewBox="0 0 24 24"
          >
            <style>
              {"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
            </style>
            <path
              fill="#FFF"
              d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
              opacity={0.25}
            />
            <path
              fill="#FFF"
              d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
              style={{
                transformOrigin: "center",
                animation: "spinner_AtaB .75s infinite linear",
              }}
            />
          </svg>
        </div>
      )}
    </button>
  );
};
