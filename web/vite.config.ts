import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

// Tags every component exported from a "use client" file with __client = true, so <ServerPage>
// (src/compat/server-page.tsx) knows to leave it for React instead of calling it as a server component.
function markClientComponents(): Plugin {
  return {
    name: "mark-client-components",
    enforce: "pre",
    transform(code, id) {
      if (!/\/src\/.*\.tsx$/.test(id)) return null;
      if (!/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(code)) return null;
      const names = new Set<string>();
      for (const m of code.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z]\w*)/g)) names.add(m[1]);
      for (const m of code.matchAll(/export\s+const\s+([A-Z]\w*)\s*=/g)) names.add(m[1]);
      if (!names.size) return null;
      const tags = [...names].map((n) => `try { ${n}.__client = true; } catch {}`).join("\n");
      return { code: `${code}\n${tags}\n`, map: null };
    },
  };
}

// The pages were ported from the Next.js dashboard. The few Next.js imports they still use resolve to
// small browser versions in src/compat (see src/compat/README.md); new pages should not use them.
export default defineConfig({
  plugins: [markClientComponents(), react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^next\/link$/, replacement: src("compat/link.tsx") },
      { find: /^next\/navigation$/, replacement: src("compat/navigation.ts") },
      { find: /^next\/cache$/, replacement: src("compat/cache.ts") },
      { find: /^server-only$/, replacement: src("compat/empty.ts") },
      { find: /^@\//, replacement: src("") },
    ],
  },
  build: { chunkSizeWarningLimit: 1500 },
});
