import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthUser } from '@steamfarm/shared';

export const DEFAULT_AUTH_USER: AuthUser = {
  id: 1,
  username: 'admin',
  label: 'Admin Teste',
  avatar_url: '',
  is_super: true,
  premium_themes: true,
};

type AuthState = {
  user: AuthUser | null;
  setUser: (u: AuthUser | null) => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: DEFAULT_AUTH_USER,
      setUser: (user) => set({ user }),
    }),
    {
      name: 'sf-auth-user',
    },
  ),
);
