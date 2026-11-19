import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { Card, Loaded, Select } from "@/ui";
import { SignedImage, uploadCatalogFile, useCanWriteMaster } from "../shared";

type Photo = { id: string; model_id: string; color_id: string; image_path: string; sort_order: number; colors: { name: string } | null };

export default function ColourPhotos() {
  const canWrite = useCanWriteMaster("catalog");
  const models = useQuery(async () => must(await supabase.from("models").select("id, name").order("name")) as { id: string; name: string }[], []);
  const colors = useQuery(async () => must(await supabase.from("colors").select("id, name").order("name")) as { id: string; name: string }[], []);
  const [modelId, setModelId] = useState("");
  const [colorId, setColorId] = useState("");
  const photos = useQuery(
    async () =>
      modelId
        ? (must(
            await supabase.from("model_colour_photos").select("id, model_id, color_id, image_path, sort_order, colors(name)").eq("model_id", modelId).order("sort_order"),
          ) as unknown as Photo[])
        : [],
    [modelId],
  );
  return (
    <Card title="Photos per model and colour">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Select value={modelId} onChange={setModelId} options={models.data ?? []} placeholder="Model" />
        {canWrite && modelId && (
          <>
            <Select value={colorId} onChange={setColorId} options={colors.data ?? []} placeholder="Colour" />
            <input
              type="file"
              accept="image/*"
              disabled={!colorId}
              className="text-xs"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const path = await uploadCatalogFile(`models/${modelId}`, file);
                  must(await supabase.from("model_colour_photos").insert({ model_id: modelId, color_id: colorId, image_path: path, sort_order: (photos.data?.length ?? 0) + 1 }));
                  photos.reload();
                } catch (err) {
                  alert(err instanceof Error ? err.message : String(err));
                }
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
      <Loaded q={photos}>
        {(rows) => (
          <div className="flex flex-wrap gap-3 px-3 py-2">
            {rows.length === 0 && <p className="text-sm text-slate-400">No photos for this model.</p>}
            {rows.map((p) => (
              <figure key={p.id} className="w-40 text-xs">
                <SignedImage path={p.image_path} />
                <figcaption className="mt-1 flex justify-between">
                  {p.colors?.name}
                  {canWrite && (
                    <button
                      type="button"
                      className="text-red-600"
                      onClick={async () => {
                        must(await supabase.from("model_colour_photos").delete().eq("id", p.id));
                        photos.reload();
                      }}
                    >
                      Remove
                    </button>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Loaded>
    </Card>
  );
}
