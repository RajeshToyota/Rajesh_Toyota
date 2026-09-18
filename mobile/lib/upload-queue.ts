import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "@/lib/supabase";
import { uploadQuotePdf } from "@/lib/quote-document";

// If a quote PDF upload fails mid-share (network drop is the common case — expo-print itself
// runs entirely on-device so it always succeeds), the local file is still sitting in the app's
// cache directory. Rather than losing it, queue it here and retry automatically next time we
// see a network connection (OfflineBanner) or the app restarts (flushed from the home screen).

const STORAGE_KEY = "pending-quote-pdf-uploads";

interface PendingUpload {
  quoteId: string;
  employeeId: string;
  localUri: string;
  queuedAt: string;
}

async function readQueue(): Promise<PendingUpload[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function writeQueue(queue: PendingUpload[]) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

export async function queuePendingUpload(item: Omit<PendingUpload, "queuedAt">) {
  const queue = await readQueue();
  queue.push({ ...item, queuedAt: new Date().toISOString() });
  await writeQueue(queue);
}

export async function flushPendingUploads(): Promise<{ succeeded: number; remaining: number }> {
  const queue = await readQueue();
  if (queue.length === 0) return { succeeded: 0, remaining: 0 };

  const stillPending: PendingUpload[] = [];
  let succeeded = 0;

  for (const item of queue) {
    try {
      await uploadQuotePdf(item.localUri, item.employeeId, item.quoteId);
      await supabase
        .from("quotes")
        .update({ status: "sent", pdf_storage_path: `${item.employeeId}/${item.quoteId}.pdf` })
        .eq("id", item.quoteId);
      succeeded++;
    } catch {
      // Still offline, or the local file is gone (cache cleared) — either way, leave it queued;
      // a permanently-missing local file will just keep failing silently, which is preferable
      // to crashing the flush for every other queued item.
      stillPending.push(item);
    }
  }

  await writeQueue(stillPending);
  return { succeeded, remaining: stillPending.length };
}

export async function pendingUploadCount(): Promise<number> {
  return (await readQueue()).length;
}
