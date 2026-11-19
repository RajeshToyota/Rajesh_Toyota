import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { Card, RunButton, Select, inputCls } from "@/ui";
import { SignedImage, uploadCatalogFile, useCanWriteMaster, useVariants, variantLabel } from "../shared";

type Content = { variant_id: string; features: string[]; images: { path: string; color_id: string | null }[] };

// Features and up to seven colour-tagged images per variant (Techwheels' Variant Content).
export default function VariantContent() {
  const canWrite = useCanWriteMaster("catalog");
  const variants = useVariants();
  const colors = useQuery(async () => must(await supabase.from("colors").select("id, name").order("name")) as { id: string; name: string }[], []);
  const [variantId, setVariantId] = useState("");
  const [features, setFeatures] = useState("");
  const [images, setImages] = useState<Content["images"]>([]);
  const content = useQuery(
    async () => (variantId ? ((must(await supabase.from("variant_content").select("variant_id, features, images").eq("variant_id", variantId).maybeSingle()) as Content | null) ?? null) : null),
    [variantId],
  );
  useEffect(() => {
    setFeatures((content.data?.features ?? []).join("\n"));
    setImages(content.data?.images ?? []);
  }, [content.data]);

  return (
    <Card title="Variant content" note="One feature per line; up to seven images, each tagged with the colour it shows.">
      <div className="space-y-3 px-3 py-2 text-sm">
        <Select value={variantId} onChange={setVariantId} placeholder="Variant" options={(variants.data ?? []).map((v) => ({ id: v.id, name: variantLabel(v) }))} />
        {variantId && (
          <>
            <textarea value={features} onChange={(e) => setFeatures(e.target.value)} rows={6} className={`${inputCls} w-full`} disabled={!canWrite} />
            <div className="flex flex-wrap gap-3">
              {images.map((img, i) => (
                <div key={img.path} className="w-40 text-xs">
                  <SignedImage path={img.path} />
                  <Select
                    value={img.color_id ?? ""}
                    onChange={(v) => setImages(images.map((x, j) => (j === i ? { ...x, color_id: v || null } : x)))}
                    options={colors.data ?? []}
                    placeholder="Colour"
                    className="mt-1 w-full"
                  />
                  {canWrite && (
                    <button type="button" className="text-red-600" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canWrite && (
              <div className="flex items-center gap-3">
                {images.length < 7 && (
                  <input
                    type="file"
                    accept="image/*"
                    className="text-xs"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const path = await uploadCatalogFile(`variants/${variantId}`, file);
                        setImages([...images, { path, color_id: null }]);
                      } catch (err) {
                        alert(err instanceof Error ? err.message : String(err));
                      }
                      e.target.value = "";
                    }}
                  />
                )}
                <RunButton
                  label="Save content"
                  run={async () => {
                    must(
                      await supabase.from("variant_content").upsert({
                        variant_id: variantId,
                        features: features.split("\n").map((f) => f.trim()).filter(Boolean),
                        images,
                        updated_at: new Date().toISOString(),
                      }),
                    );
                    content.reload();
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
