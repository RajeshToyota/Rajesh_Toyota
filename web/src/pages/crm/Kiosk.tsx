import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { must, useQuery } from "@/lib/query";
import { rpc, rpcRows } from "@/ui";

type Returning = { visits: number; last_visit: string | null; last_name: string | null; last_consultant_id: string | null; last_consultant: string | null; last_model_id: string | null; open_enquiry_owner: string | null };
type Opt = { id: string; name: string };
type Form = {
  customer_name: string;
  mobile: string;
  model_id: string;
  fuel_types: string[];
  has_exchange: boolean | null;
  exchange_reg_no: string;
  exchange_model: string;
  assigned_employee_id: string;
  finance_required: boolean | null;
  financier_id: string;
};
const EMPTY: Form = { customer_name: "", mobile: "", model_id: "", fuel_types: [], has_exchange: null, exchange_reg_no: "", exchange_model: "", assigned_employee_id: "", finance_required: null, financier_id: "" };
const FUELS = ["Petrol", "Diesel", "CNG", "Hybrid", "EV"];
const STEPS = ["welcome", "contact", "returning", "model", "fuel", "exchange", "consultant", "finance", "financier", "token"] as const;
type Step = (typeof STEPS)[number];

// Techwheels' reception kiosk: the customer taps through on a tablet and gets a token; the visit lands on
// the consultant's screen. Resets itself after the token is shown.
export default function Kiosk() {
  const [step, setStep] = useState<Step>("welcome");
  const [f, setF] = useState<Form>(EMPTY);
  const [ret, setRet] = useState<Returning | null>(null);
  const [token, setToken] = useState<{ token_no: string; consultant: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const models = useQuery(async () => must(await supabase.from("models").select("id, name").eq("is_active", true).order("name")) as Opt[], []);
  const consultants = useQuery(() => rpcRows<Opt & { waiting: number }>("branch_consultants", {}), []);
  const financiers = useQuery(async () => must(await supabase.from("financiers").select("id, name").eq("is_active", true).order("name")) as Opt[], []);

  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const reset = () => {
    setF(EMPTY);
    setRet(null);
    setToken(null);
    setError(null);
    setStep("welcome");
  };
  useEffect(() => {
    if (step !== "token") return;
    const t = setTimeout(reset, 15000);
    return () => clearTimeout(t);
  }, [step]);

  async function afterContact() {
    setError(null);
    if (!/^\d{10}$/.test(f.mobile.replace(/\D/g, "").slice(-10)) || !f.customer_name.trim()) return setError("Enter your name and 10-digit mobile number");
    const [r] = await rpcRows<Returning>("kiosk_detect_returning", { p_mobile: f.mobile });
    if (r && r.visits > 0) {
      setRet(r);
      set({ model_id: r.last_model_id ?? "", assigned_employee_id: r.last_consultant_id ?? "" });
      setStep("returning");
    } else setStep("model");
  }
  async function finish(patch: Partial<Form> = {}) {
    const p = { ...f, ...patch };
    setBusy(true);
    setError(null);
    try {
      const [r] = await rpc<{ token_no: string; consultant: string | null }[]>("kiosk_create_walkin", {
        p: {
          customer_name: p.customer_name,
          mobile: p.mobile,
          model_id: p.model_id || null,
          fuel_types: p.fuel_types,
          has_exchange: !!p.has_exchange,
          exchange_reg_no: p.exchange_reg_no || null,
          exchange_model: p.exchange_model || null,
          assigned_employee_id: p.assigned_employee_id || null,
          finance_required: p.finance_required,
          financier_id: p.financier_id || null,
        },
      });
      setToken(r);
      setStep("token");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const big = "rounded-2xl border-2 border-slate-200 px-6 py-5 text-xl font-medium text-slate-800 hover:border-slate-900 active:bg-slate-100";
  const on = "border-slate-900 bg-slate-900 text-white hover:border-slate-900";
  const field = "w-full rounded-xl border-2 border-slate-300 px-4 py-3 text-xl";
  const next = (to: Step, label = "Next") => (
    <button type="button" className="mt-6 w-full rounded-2xl bg-slate-900 py-4 text-xl font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => setStep(to)}>
      {label}
    </button>
  );

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-2xl flex-col justify-center px-4 py-8">
      <div className="mb-4 flex items-center justify-between text-sm text-slate-500">
        <span>Rajesh Toyota</span>
        <span className="flex gap-3">
          <button type="button" onClick={() => document.documentElement.requestFullscreen?.()}>Full screen</button>
          {step !== "welcome" && <button type="button" onClick={reset}>Start over</button>}
        </span>
      </div>

      {step === "welcome" && (
        <button type="button" className="rounded-3xl bg-slate-900 px-8 py-16 text-center text-white" onClick={() => setStep("contact")}>
          <div className="text-4xl font-semibold">Welcome to Rajesh Toyota</div>
          <div className="mt-3 text-xl text-slate-300">Tap to check in</div>
        </button>
      )}

      {step === "contact" && (
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold">Your details</h2>
          <input className={field} placeholder="Your name" value={f.customer_name} onChange={(e) => set({ customer_name: e.target.value })} />
          <input className={field} placeholder="Mobile number" inputMode="numeric" value={f.mobile} onChange={(e) => set({ mobile: e.target.value })} />
          <button type="button" className="w-full rounded-2xl bg-slate-900 py-4 text-xl font-semibold text-white" onClick={afterContact}>Next</button>
        </div>
      )}

      {step === "returning" && ret && (
        <div className="space-y-3 text-center">
          <h2 className="text-3xl font-semibold">Welcome back{ret.last_name ? `, ${ret.last_name}` : ""}!</h2>
          <p className="text-lg text-slate-600">
            This is visit {ret.visits + 1}.{ret.last_consultant ? ` Last time you met ${ret.last_consultant}.` : ""}
            {ret.open_enquiry_owner ? ` ${ret.open_enquiry_owner} is handling your enquiry.` : ""}
          </p>
          {next("model", "Continue")}
        </div>
      )}

      {step === "model" && (
        <div>
          <h2 className="mb-4 text-2xl font-semibold">Which car are you interested in?</h2>
          <div className="grid grid-cols-2 gap-3">
            {(models.data ?? []).map((m) => (
              <button key={m.id} type="button" className={`${big} ${f.model_id === m.id ? on : ""}`} onClick={() => set({ model_id: m.id })}>{m.name}</button>
            ))}
            <button type="button" className={`${big} ${f.model_id === "" ? on : ""}`} onClick={() => set({ model_id: "" })}>Not sure yet</button>
          </div>
          {next("fuel")}
        </div>
      )}

      {step === "fuel" && (
        <div>
          <h2 className="mb-4 text-2xl font-semibold">Fuel preference (any)</h2>
          <div className="grid grid-cols-3 gap-3">
            {FUELS.map((x) => (
              <button key={x} type="button" className={`${big} ${f.fuel_types.includes(x) ? on : ""}`} onClick={() => set({ fuel_types: f.fuel_types.includes(x) ? f.fuel_types.filter((y) => y !== x) : [...f.fuel_types, x] })}>{x}</button>
            ))}
          </div>
          {next("exchange")}
        </div>
      )}

      {step === "exchange" && (
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold">Do you have a car to exchange?</h2>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className={`${big} ${f.has_exchange === true ? on : ""}`} onClick={() => set({ has_exchange: true })}>Yes</button>
            <button type="button" className={`${big} ${f.has_exchange === false ? on : ""}`} onClick={() => set({ has_exchange: false, exchange_reg_no: "", exchange_model: "" })}>No</button>
          </div>
          {f.has_exchange && (
            <>
              <input className={field} placeholder="Registration number (e.g. RJ14 AB 1234)" value={f.exchange_reg_no} onChange={(e) => set({ exchange_reg_no: e.target.value })} />
              <input className={field} placeholder="Make and model (e.g. Maruti Swift)" value={f.exchange_model} onChange={(e) => set({ exchange_model: e.target.value })} />
            </>
          )}
          {f.has_exchange !== null && next("consultant")}
        </div>
      )}

      {step === "consultant" && (
        <div>
          <h2 className="mb-4 text-2xl font-semibold">Who would you like to meet?</h2>
          <div className="grid grid-cols-2 gap-3">
            {(consultants.data ?? []).map((c) => (
              <button key={c.id} type="button" className={`${big} ${f.assigned_employee_id === c.id ? on : ""}`} onClick={() => set({ assigned_employee_id: c.id })}>
                {c.name}
                {c.waiting > 0 && <div className="text-sm font-normal opacity-70">{c.waiting} waiting</div>}
              </button>
            ))}
            <button type="button" className={`${big} ${f.assigned_employee_id === "" ? on : ""}`} onClick={() => set({ assigned_employee_id: "" })}>Anyone available</button>
          </div>
          {next("finance")}
        </div>
      )}

      {step === "finance" && (
        <div>
          <h2 className="mb-4 text-2xl font-semibold">Will you need a car loan?</h2>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className={big} onClick={() => { set({ finance_required: true }); setStep("financier"); }}>Yes</button>
            <button type="button" className={big} disabled={busy} onClick={() => { set({ finance_required: false, financier_id: "" }); finish({ finance_required: false, financier_id: "" }); }}>No</button>
          </div>
        </div>
      )}

      {step === "financier" && (
        <div>
          <h2 className="mb-4 text-2xl font-semibold">Any preferred bank?</h2>
          <div className="grid grid-cols-2 gap-3">
            {(financiers.data ?? []).map((b) => (
              <button key={b.id} type="button" className={`${big} ${f.financier_id === b.id ? on : ""}`} onClick={() => set({ financier_id: b.id })}>{b.name}</button>
            ))}
            <button type="button" className={`${big} ${f.financier_id === "" ? on : ""}`} onClick={() => set({ financier_id: "" })}>Not decided</button>
          </div>
          <button type="button" className="mt-6 w-full rounded-2xl bg-slate-900 py-4 text-xl font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => finish()}>
            {busy ? "…" : "Get my token"}
          </button>
        </div>
      )}

      {step === "token" && token && (
        <div className="rounded-3xl border-4 border-emerald-600 px-8 py-12 text-center">
          <div className="text-xl text-slate-600">Your token</div>
          <div className="my-4 text-7xl font-bold tracking-wider text-emerald-700">{token.token_no}</div>
          <div className="text-xl text-slate-700">{token.consultant ? `${token.consultant} will be with you shortly.` : "A consultant will be with you shortly."}</div>
          <button type="button" className="mt-8 text-slate-500 underline" onClick={reset}>Done</button>
        </div>
      )}

      {error && <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-lg text-red-700">{error}</div>}
    </div>
  );
}
