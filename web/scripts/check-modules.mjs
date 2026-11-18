// Build check (the Techwheels syncAdminModules idea, without writing to the database): every route's
// module key must be seeded in app_modules by a migration, and every module with a menu path must have
// a route. Run: node scripts/check-modules.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const routesSrc = ["src/App.tsx", "src/routes.tsx"].map((f) => readFileSync(join(root, f), "utf8")).join("\n");
const routeKeys = new Set([...routesSrc.matchAll(/module: "([a-z0-9_]+)"/g)].map((m) => m[1]));
const routePaths = new Set([...routesSrc.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]));

const migDir = join(root, "../supabase/migrations");
const sql = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(migDir, f), "utf8")).join("\n");
const modules = new Map();
for (const block of sql.matchAll(/insert into app_modules[^;]*?values([\s\S]*?);/g)) {
  for (const m of block[1].matchAll(/\(\s*'([a-z0-9_]+)',\s*'[a-z_]+',\s*'[^']*',\s*(null|'[^']*')/g)) {
    modules.set(m[1], m[2] === "null" ? null : m[2].slice(1, -1));
  }
}

const errors = [];
for (const k of routeKeys) if (!modules.has(k)) errors.push(`route module "${k}" is not seeded in app_modules`);
for (const [k, path] of modules) if (path && !routePaths.has(path)) errors.push(`module "${k}" has menu path ${path} but no route`);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`modules ok: ${modules.size} modules, ${routeKeys.size} route keys, ${routePaths.size} routes`);
