import { View, Text, TextInput, Switch } from "react-native";
import { PickerList, CheckboxRow } from "@/components/picker-list";
import type { VehicleSelection } from "@/hooks/use-vehicle-selection";

// Renders one step (0-9, see VEHICLE_STEP_TITLES in the hook) of the shared vehicle/scheme/RTO/
// insurance/accessory/VAS selection flow used by both the quote wizard and the direct-booking
// wizard.
export function VehicleSelectionStep({ step, vs }: { step: number; vs: VehicleSelection }) {
  switch (step) {
    case 0:
      return (
        <PickerList
          options={vs.models.map((m) => ({ id: m.id, label: m.name }))}
          selectedId={vs.modelId}
          onSelect={(id) => {
            vs.setModelId(id);
            vs.setFuelTypeId(null);
            vs.setTransmissionId(null);
            vs.setVariantId(null);
            vs.setColorId(null);
          }}
        />
      );

    case 1:
      return (
        <PickerList
          options={vs.availableFuelTypes}
          selectedId={vs.fuelTypeId}
          onSelect={(id) => {
            vs.setFuelTypeId(id);
            vs.setTransmissionId(null);
            vs.setVariantId(null);
          }}
        />
      );

    case 2:
      return (
        <PickerList
          options={vs.availableTransmissions}
          selectedId={vs.transmissionId}
          onSelect={(id) => {
            vs.setTransmissionId(id);
            vs.setVariantId(null);
          }}
        />
      );

    case 3:
      return (
        <PickerList
          options={vs.availableVariants}
          selectedId={vs.variantId}
          onSelect={(id) => {
            vs.setVariantId(id);
            vs.setColorId(null);
          }}
        />
      );

    case 4:
      return (
        <PickerList
          options={vs.colors.map((c) => ({
            id: c.id,
            label: c.name,
            sublabel: c.extra_cost > 0 ? `+₹${c.extra_cost.toLocaleString("en-IN")}` : undefined,
          }))}
          selectedId={vs.colorId}
          onSelect={vs.setColorId}
        />
      );

    case 5:
      return (
        <View className="gap-4">
          <PickerList
            options={vs.rtoCategories.map((r) => ({ id: r.id, label: r.name }))}
            selectedId={vs.rtoCategoryId}
            onSelect={(id) => {
              vs.setRtoCategoryId(id);
              vs.setScrapSource(null);
            }}
          />

          {vs.isScrapLinkedRto && (
            <View className="gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <Text className="font-medium text-amber-900">Scrap Certificate</Text>
              <PickerList
                options={[
                  { id: "Self", label: "Self-arranged" },
                  { id: "Rajesh Toyota", label: "Via Rajesh Toyota" },
                ]}
                selectedId={vs.scrapSource}
                onSelect={(id) => vs.setScrapSource(id as "Self" | "Rajesh Toyota")}
              />
              {vs.scrapSource === "Rajesh Toyota" && (
                <>
                  <TextInput
                    value={vs.scrapAmount}
                    onChangeText={vs.setScrapAmount}
                    keyboardType="numeric"
                    placeholder="Scrap bonus amount"
                    className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-base"
                  />
                  <TextInput
                    value={vs.scrapCertificateNumber}
                    onChangeText={vs.setScrapCertificateNumber}
                    placeholder="Certificate number (if available)"
                    className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-base"
                  />
                </>
              )}
            </View>
          )}
        </View>
      );

    case 6:
      return (
        <View className="gap-3">
          <View className="mb-1 flex-row items-center justify-between rounded-xl border border-slate-200 p-4">
            <Text className="font-medium text-slate-900">Vehicle exchange included?</Text>
            <Switch value={vs.hasExchange} onValueChange={vs.setHasExchange} />
          </View>

          {vs.schemeLineItems.length === 0 ? (
            <Text className="py-6 text-center text-slate-400">No active schemes for this model right now.</Text>
          ) : (
            vs.schemeLineItems.map((item: any) => {
              const disabled = item.condition?.requires_exchange && !vs.hasExchange;
              return (
                <CheckboxRow
                  key={item.id}
                  label={item.line_type}
                  sublabel={disabled ? "Requires vehicle exchange" : item.condition?.mutually_exclusive_group ? "Choose one" : undefined}
                  checked={vs.selectedSchemeIds.includes(item.id)}
                  onToggle={() => !disabled && vs.toggleScheme(item.id)}
                />
              );
            })
          )}
        </View>
      );

    case 7:
      return (
        <View className="gap-4">
          <PickerList
            options={[
              { id: "self", label: "Self (customer arranges insurance)" },
              { id: "rajesh_toyota", label: "Via Rajesh Toyota" },
            ]}
            selectedId={vs.insuranceChoice}
            onSelect={(id) => {
              vs.setInsuranceChoice(id as "self" | "rajesh_toyota");
              vs.setInsurancePlanId(null);
              vs.setInsuranceAddonIds([]);
            }}
          />

          {vs.insuranceChoice === "rajesh_toyota" && (
            <>
              <Text className="mt-2 font-medium text-slate-700">Coverage</Text>
              <PickerList
                options={vs.insurancePlans.map((p: any) => ({ id: p.id, label: p.coverage_type }))}
                selectedId={vs.insurancePlanId}
                onSelect={vs.setInsurancePlanId}
              />

              {vs.insurancePlanId && (
                <>
                  <Text className="mt-2 font-medium text-slate-700">Add-ons</Text>
                  {vs.insuranceAddons.map((addon: any) => (
                    <CheckboxRow
                      key={addon.id}
                      label={addon.name}
                      sublabel={`₹${addon.price.toLocaleString("en-IN")}`}
                      checked={vs.insuranceAddonIds.includes(addon.id)}
                      onToggle={() => vs.toggleFrom(vs.insuranceAddonIds, vs.setInsuranceAddonIds, addon.id)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </View>
      );

    case 8:
      return (
        <View className="gap-2">
          {vs.accessories.length === 0 ? (
            <Text className="py-6 text-center text-slate-400">No accessories configured for this variant.</Text>
          ) : (
            vs.accessories.map((a: any) => (
              <CheckboxRow
                key={a.id}
                label={a.name}
                sublabel={`₹${a.price.toLocaleString("en-IN")}`}
                checked={vs.accessoryIds.includes(a.id)}
                onToggle={() => vs.toggleFrom(vs.accessoryIds, vs.setAccessoryIds, a.id)}
              />
            ))
          )}
        </View>
      );

    case 9:
      return (
        <View className="gap-2">
          {vs.vasProducts.length === 0 ? (
            <Text className="py-6 text-center text-slate-400">No VAS products configured.</Text>
          ) : (
            vs.vasProducts.map((v: any) => (
              <CheckboxRow
                key={v.id}
                label={v.name}
                sublabel={`₹${v.price.toLocaleString("en-IN")}`}
                checked={vs.vasProductIds.includes(v.id)}
                onToggle={() => vs.toggleFrom(vs.vasProductIds, vs.setVasProductIds, v.id)}
              />
            ))
          )}
        </View>
      );

    default:
      return null;
  }
}
