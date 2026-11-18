import { refreshPages } from "./refresh";

// Next.js revalidatePath(): in a single-page app there is no server cache, so reload what is on screen.
export function revalidatePath(_path?: string, _type?: "page" | "layout") {
  refreshPages();
}
