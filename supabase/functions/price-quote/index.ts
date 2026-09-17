// price-quote: the only place the mobile app (and the "Proceed to Booking" re-pricing step)
// gets a total. It always calls the shared `calculate_price` Postgres function so quote and
// booking numbers can never drift apart, and it is the enforcement point for hiding
// `dealer_margin` from roles that shouldn't see it (Sales Consultant and below) — the client is
// never trusted to do that filtering itself.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { selections?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!body.selections || typeof body.selections !== "object") {
    return new Response(JSON.stringify({ error: "Body must include a `selections` object" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Client scoped to the caller's own JWT: RLS governs what it can read (master/catalog data is
  // open to any authenticated employee, so calculate_price works normally under this client).
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: priced, error: priceError } = await supabase.rpc("calculate_price", {
    selections: body.selections,
  });

  if (priceError) {
    return new Response(JSON.stringify({ error: priceError.message }), {
      status: 422,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Determine whether the caller's role is senior enough to see dealer_margin. "Above Sales
  // Consultant" is resolved by rank comparison against the Sales Consultant role's rank, not a
  // hardcoded number, so it stays correct if ranks are ever renumbered from the dashboard.
  const [{ data: callerRank }, { data: scRole }] = await Promise.all([
    supabase.rpc("current_employee_role_rank"),
    supabase.from("roles").select("rank").eq("name", "Sales Consultant").maybeSingle(),
  ]);

  const authorizedForMargin =
    callerRank !== null && callerRank !== undefined &&
    scRole?.rank !== null && scRole?.rank !== undefined &&
    callerRank < scRole.rank;

  const response = { ...priced };
  if (!authorizedForMargin) {
    delete response.dealer_margin;
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
