"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { entityGroups } from "@/lib/entities";

const extraLinks: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Reporting",
    links: [{ href: "/reports", label: "Quotes & Bookings" }],
  },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="space-y-6">
      {extraLinks.map((group) => (
        <div key={group.title}>
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {group.title}
          </p>
          <ul className="mt-1 space-y-0.5">
            {group.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`block rounded-md px-3 py-1.5 text-sm ${
                    pathname === link.href
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {entityGroups.map((group) => (
        <div key={group.title}>
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {group.title}
          </p>
          <ul className="mt-1 space-y-0.5">
            {group.entities.map((entity) => {
              const href = `/admin/${entity.slug}`;
              const active = pathname === href;
              return (
                <li key={entity.slug}>
                  <Link
                    href={href}
                    className={`block rounded-md px-3 py-1.5 text-sm ${
                      active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {entity.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
