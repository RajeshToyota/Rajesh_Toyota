# Next.js compatibility layer

The pages in `src/pages` were moved over from the old Next.js dashboard (`dashboard/`) without
rewriting them. These files let that code run unchanged in this Vite single-page app:

| Next.js API | Here |
|---|---|
| `next/link` | `link.tsx`: a react-router `<Link>` that takes `href` |
| `next/navigation` | `navigation.ts`: `useRouter`, `usePathname`, `useSearchParams`, `redirect`, `notFound` |
| `next/cache` `revalidatePath` | `cache.ts`: re-runs the data loading of the pages on screen |
| async server components | `server-page.tsx`: `<ServerPage>` runs the async page in the browser and renders the result |
| `@/lib/supabase/server` | the browser Supabase client; RLS decides what each user sees, as before |
| `"use server"` actions | plain async functions that call Supabase RPCs from the browser |

How `<ServerPage>` works: it calls the page function with `params` and `searchParams`, then walks
the returned tree. Every component that is not from a `"use client"` file is a server component,
so it is called and its output walked too (async ones are awaited). Components from `"use client"`
files are left for React to render; the Vite plugin `markClientComponents` in `vite.config.ts`
tags them.

New pages should be ordinary React components (hooks + `supabase.rpc`), as in Techwheels. Port the
old pages to that style when you next work on them, then delete this folder.
