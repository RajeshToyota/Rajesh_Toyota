import { create } from "zustand";

// A counter every <ServerPage> watches: bump it and the pages on screen load their data again.
// This stands in for Next.js revalidatePath() and router.refresh().
export const useRefreshStore = create<{ version: number; bump: () => void }>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));

export const refreshPages = () => useRefreshStore.getState().bump();
