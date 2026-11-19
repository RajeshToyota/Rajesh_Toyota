import { useState } from "react";
import { useQuery } from "@/lib/query";
import { Card, EmptyRow, Loaded, Select, Table, Td, inr, rpcRows, titleCase } from "@/ui";
import { useVariants, variantLabel } from "../shared";

type Acc = { id: string; name: string; part_no: string | null; price: number; is_top: boolean; is_pack: boolean; is_universal: boolean; variant_group: string | null };

// What a consultant can sell on one variant: its model's accessories plus universal ones not excluded.
export default function AccessoriesByVariant() {
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
