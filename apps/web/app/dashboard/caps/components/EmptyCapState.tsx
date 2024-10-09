import { Button } from "@cap/ui";

interface EmptyCapStateProps {
  userName?: string;
}

export const EmptyCapState: React.FC<EmptyCapStateProps> = ({ userName }) => {
  return (
    <div className="flex flex-col items-center justify-center">
      <div className="w-full max-w-md mx-auto">
        <img
          className="w-full h-auto"
          src="/illustrations/person-microphone.svg"
          alt="Person using microphone"
        />
      </div>
      <div className="text-center pb-[30px]">
        <h1 className="text-2xl font-semibold mb-3">
          <span className="block">Hey{userName ? `, ${userName}` : ""}!</span>
          <span className="block">Record your first Cap.</span>
        </h1>
        <p className="text-xl max-w-md">
          Craft your narrative with a Cap—get projects done quicker.
        </p>
        <div className="flex justify-center mt-8">
          <Button
            href="/download"
            size="lg"
            className="relative"
            variant="primary"
          >
            Download Cap
          </Button>
        </div>
      </div>
    </div>
  );
};
