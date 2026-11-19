import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { Card, EmptyRow, Loaded, RunButton, Select, Table, Td, inr, inputCls, rpcRows, titleCase } from "@/ui";
import { MasterTabs, catalogFileUrl, uploadCatalogFile, useCanWriteMaster, useVariants, variantLabel } from "./shared";

// Cars & Variants (Techwheels' Cars, Variants, Car Colours, Variant Content, Accessories, Extended
// Warranty and TGLOSS (ceramic coating) screens), on one page.
export default function Catalog() {
  return (
    <MasterTabs
      page="catalog"
      title="Cars & Variants"
      note="Prices come from the TKM price list. Tax data on the variant is used by the RTO formula; content and photos are for the quote and the customer."
      panels={{
        photos: () => <ColourPhotos />,
        content: () => <VariantContent />,
        "accessory-check": () => <AccessoriesByVariant />,
      }}
    />
  );
}

type Photo = { id: string; model_id: string; color_id: string; image_path: string; sort_order: number; colors: { name: string } | null };

function ColourPhotos() {
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

function SignedImage({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    catalogFileUrl(path).then(setUrl);
  }, [path]);
  return url ? <img src={url} alt="" className="h-28 w-40 rounded border border-slate-200 object-cover" /> : <div className="h-28 w-40 rounded bg-slate-100" />;
}

type Content = { variant_id: string; features: string[]; images: { path: string; color_id: string | null }[] };

// Features and up to seven colour-tagged images per variant (Techwheels' Variant Content).
function VariantContent() {
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

type Acc = { id: string; name: string; part_no: string | null; price: number; is_top: boolean; is_pack: boolean; is_universal: boolean; variant_group: string | null };

// What a consultant can sell on one variant: its model's accessories plus universal ones not excluded.
function AccessoriesByVariant() {
  const variants = useVariants();
  const [variantId, setVariantId] = useState("");
  const rows = useQuery(() => (variantId ? rpcRows<Acc>("accessories_for_variant", { p_variant_id: variantId }) : Promise.resolve([] as Acc[])), [variantId]);
  const ew = useQuery(
    () => (variantId ? rpcRows<{ product: string; km_limit: number | null; price: number }>("ew_options_for_variant", { p_variant_id: variantId }) : Promise.resolve([])),
    [variantId],
  );
  return (
    <>
      <div className="mb-3">
        <Select value={variantId} onChange={setVariantId} placeholder="Variant" options={(variants.data ?? []).map((v) => ({ id: v.id, name: variantLabel(v) }))} />
      </div>
      <Card title="Accessories offered">
        <Loaded q={rows}>
          {(list) => (
            <Table head={["Accessory", "Part no.", "Price", ""]}>
              {list.length === 0 ? (
                <EmptyRow cols={4} text={variantId ? "No accessories for this variant." : "Pick a variant."} />
              ) : (
                list.map((a) => (
                  <tr key={a.id}>
                    <Td>{a.name}</Td>
                    <Td muted>{a.part_no}</Td>
                    <Td right>{inr(a.price)}</Td>
                    <Td muted>{[a.is_top && "Top pick", a.is_pack && "Pack", a.is_universal && "Universal", a.variant_group].filter(Boolean).join(" · ")}</Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
      <Card title="Extended warranty for a new car">
        <Loaded q={ew}>
          {(list) => (
            <Table head={["Product", "Km", "Price"]}>
              {list.length === 0 ? (
                <EmptyRow cols={3} text="No warranty prices for this model." />
              ) : (
                list.map((e) => (
                  <tr key={`${e.product}-${e.km_limit}`}>
                    <Td>{titleCase(e.product)}</Td>
                    <Td muted>{e.km_limit ?? "Unlimited"}</Td>
                    <Td right>{inr(e.price)}</Td>
                  </tr>
                ))
              )}
            </Table>
          )}
        </Loaded>
      </Card>
    </>
  );
}

