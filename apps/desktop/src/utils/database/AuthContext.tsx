import { createContext, useState, useEffect, useContext, useRef } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/utils/database/client";

interface AuthContextProps {
  session: Session | null;
  user: User | null;
  userRef: React.MutableRefObject<User | null>;
}

const AuthContext = createContext<AuthContextProps>({
  session: null,
  user: null,
  userRef: { current: null },
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<React.PropsWithChildren<{}>> = ({
  children,
}) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const userRef = useRef<User | null>(null);

  useEffect(() => {
    const updateAuthState = (session: Session | null) => {
      setSession(session);
      setUser(session?.user || null);
      userRef.current = session?.user || null; // Update the ref whenever the user state changes
    };

    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (error) {
        console.error("Error retrieving session:", error);
        return;
      }
      updateAuthState(session);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        updateAuthState(session);
      }
    );

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ session, user, userRef }}>
      {children}
    </AuthContext.Provider>
  );
};
