import { create } from 'zustand';
import type { AuthUser } from '@steamfarm/shared';

type AuthState = {
  user: AuthUser | null;
  setUser: (u: AuthUser | null) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));
