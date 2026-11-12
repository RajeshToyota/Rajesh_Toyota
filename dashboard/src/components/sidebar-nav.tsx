"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { entityGroups } from "@/lib/entities";

type NavLink = { href: string; label: string };
type NavGroup = { title: string; links?: NavLink[]; subgroups?: { title: string; links: NavLink[] }[] };

const navGroups: NavGroup[] = [
  {
    title: "Sales",
    links: [
      { href: "/enquiries", label: "Enquiries" },
      { href: "/enquiries/new", label: "New Enquiry" },
      { href: "/crm-sync", label: "CTDMS Sync" },
      { href: "/finance", label: "Finance Cases" },
    ],
  },
  {
    title: "Stock",
    links: [
      { href: "/stock", label: "Free Stock" },
      { href: "/stock/pool", label: "Allotment Pool" },
      { href: "/stock/finance-queue", label: "Finance Queue" },
      { href: "/stock/vna", label: "VNA Demand" },
      { href: "/stock/match", label: "Match & Allot" },
      { href: "/stock/allotted", label: "Allotted" },
      { href: "/stock/billing", label: "Billing" },
      { href: "/payments", label: "Payments" },
      { href: "/cancellations", label: "Hold & Cancellations" },
      { href: "/stock/ctdms", label: "CTDMS To-do" },
      { href: "/stock/import", label: "Import Stock" },
    ],
  },
  {
    title: "People",
    links: [
      { href: "/hr", label: "Employees" },
      { href: "/hr/new", label: "Add Employee" },
    ],
  },
  {
    title: "Reporting",
    links: [
      { href: "/", label: "Pipeline" },
      { href: "/reports/consultants", label: "Consultants" },
      { href: "/reports/sources", label: "Sources & Reasons" },
      { href: "/reports/stock-ageing", label: "Stock Ageing" },
      { href: "/reports/quotes", label: "Quotes" },
      { href: "/reports/bookings", label: "Bookings" },
      { href: "/reports/approvals", label: "Approvals" },
      { href: "/reports/margin", label: "Margin Summary" },
    ],
  },
  {
    // Master data drills down one more level: group ▸ table.
    title: "Masters",
    subgroups: entityGroups.map((g) => ({
      title: g.title,
      links: g.entities.map((e) => ({ href: `/admin/${e.slug}`, label: e.title })),
    })),
  },
];

const groupLinks = (g: NavGroup) => [...(g.links ?? []), ...(g.subgroups ?? []).flatMap((s) => s.links)];
const groupCount = (g: NavGroup) => g.links?.length ?? g.subgroups?.length ?? 0;

// Top navigation bar: each section opens a dropdown; Masters drills down into a second flyout.
export function SidebarNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close the menu when a link is picked, the user clicks elsewhere, or presses Escape.
  const close = () => {
    setOpen(null);
    setOpenSub(null);
  };
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const isActive = (href: string) => pathname === href;

  return (
    <div ref={ref} className="relative">
      <nav className="flex flex-wrap items-stretch gap-0.5">
        {navGroups.map((group) => {
          const activeGroup = groupLinks(group).some((l) => isActive(l.href));
          const isOpen = open === group.title;
          return (
            <div key={group.title} className="relative">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpen(isOpen ? null : group.title);
                  setOpenSub(null);
                }}
                className={`flex h-full items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide ${
                  isOpen
                    ? "border-slate-900 bg-slate-100 text-slate-900"
                    : activeGroup
                      ? "border-slate-900 text-slate-900"
                      : "border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {group.title}
                <span className="text-[10px] font-normal text-slate-400">{groupCount(group)}</span>
                <span className={`text-[10px] text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}>▸</span>
              </button>

              {isOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
                  {group.links?.map((link) => (
                    <MenuLink key={link.href} link={link} active={isActive(link.href)} onPick={close} />
                  ))}
                  {group.subgroups?.map((sub) => {
                    const subOpen = openSub === sub.title;
                    const subActive = sub.links.some((l) => isActive(l.href));
                    return (
                      <div key={sub.title} className="relative" onMouseEnter={() => setOpenSub(sub.title)}>
                        <button
                          type="button"
                          onClick={() => setOpenSub(subOpen ? null : sub.title)}
                          className={`flex w-full items-center justify-between gap-4 px-4 py-2 text-left text-sm ${
                            subOpen || subActive ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-100"
                          }`}
                        >
                          {sub.title}
                          <span className="text-xs text-slate-400">
                            {sub.links.length} ▸
                          </span>
                        </button>
                        {subOpen && (
                          <div className="absolute left-full top-0 z-50 ml-1 min-w-60 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
                            {sub.links.map((link) => (
                              <MenuLink key={link.href} link={link} active={isActive(link.href)} onPick={close} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function MenuLink({ link, active, onPick }: { link: NavLink; active: boolean; onPick: () => void }) {
  return (
    <Link
      href={link.href}
      onClick={onPick}
      className={`block whitespace-nowrap px-4 py-2 text-sm ${
        active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      {link.label}
    </Link>
  );
}
