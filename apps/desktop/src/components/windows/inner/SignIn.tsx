import { useState } from "react";
// import { supabase } from "@/utils/database/client";
import { Button } from "@/components/Button";
import { Logo } from "@/components/icons/Logo";
// import toast from "react-hot-toast";

//TODO: Auth

export const SignIn = () => {
  const [email, setEmail] = useState<string>("");
  const [OTPcode, setOTPcode] = useState<string>("");
  const [enterCode, setEnterCode] = useState(false);

  // const handleLogin = async () => {
  //   const { error } = await supabase.auth.signInWithOtp({
  //     email: email,
  //   });

  //   if (error) {
  //     toast.error(`Error: ${error.message}`);
  //     console.log({ error });
  //     return;
  //   }

  //   setEnterCode(true);
  // };

  // const verifyOTPCode = async () => {
  //   if (!email || !OTPcode) {
  //     toast.error(`Error: Email or OTP code is missing`);
  //     return;
  //   }

  //   console.log({ email, OTPcode });

  //   const { error } = await supabase.auth.verifyOtp({
  //     email: email,
  //     token: OTPcode,
  //     type: "magiclink",
  //   });

  //   if (error) {
  //     toast.error(`Error: ${error.message}`);
  //     console.log({ error });
  //     return;
  //   }
  // };

  return (
    <div className="w-[85%] h-[85%] flex items-center justify-center overflow-hidden px-2 py-4 rounded-[25px] border-2 border-gray-100  bg-gradient-to-b from-gray-200 to-white flex flex-col items-center justify-center">
      <div className="wrapper wrapper-sm">
        <div className="mb-12">
          <Logo className="w-32 h-auto mx-auto" />
        </div>
        <div className="max-w-sm mx-auto flex items-center relative h-14 mb-8">
          <input
            onChange={(e) => {
              enterCode ? setOTPcode(e.target.value) : setEmail(e.target.value);
            }}
            type={enterCode ? "number" : "email"}
            placeholder={enterCode ? "Enter code" : "Your email"}
            required
            value={enterCode ? OTPcode : email}
            className="text-sm w-full bg-gray-300 rounded-full py-2 px-5 mt-3 outline-none focus-none text-black placeholder:text-gray-600 h-full"
          />
          {enterCode === false ? (
            <div className="mt-3 text-center absolute right-0 h-full">
              <Button
                handler={() => {}}
                variant="primary"
                label="Continue"
                className="h-full rounded-tr-full rounded-br-full min-w-[100px] border-none"
              />
            </div>
          ) : (
            <div className="mt-3 text-center absolute right-0 h-full">
              <Button
                handler={() => {}}
                variant="primary"
                label="Confirm"
                className="h-full rounded-tr-full rounded-br-full min-w-[100px] border-none"
              />
            </div>
          )}
        </div>
        <div className="text-center">
          <button
            type="button"
            className="underline text-sm"
            onClick={() => {
              if (enterCode) {
                setEmail("");
                setEnterCode(false);
              } else {
                setOTPcode("");
                setEnterCode(true);
              }
            }}
          >
            {enterCode ? "Don't have a code?" : "Already have a code?"}
          </button>
        </div>
      </div>
    </div>
  );
};
