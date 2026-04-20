/**
 * Tiny hook around Clerk's `useAuth` that gives us:
 *   - isSignedIn
 *   - a getter for a fresh JWT (used on every `/api/*` call)
 *
 * Pulled into its own module so the rest of the code doesn't grow a direct
 * dependency on @clerk/clerk-react — keeps the swap cost low if we ever
 * move to Auth.js or Supabase Auth.
 */
import { useAuth, useUser } from '@clerk/clerk-react';

export function useJarvisAuth() {
  const { isSignedIn, getToken, signOut } = useAuth();
  const { user } = useUser();
  return {
    isSignedIn: Boolean(isSignedIn),
    userId: user?.id ?? null,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
    avatarUrl: user?.imageUrl ?? null,
    getToken,
    signOut,
  };
}
