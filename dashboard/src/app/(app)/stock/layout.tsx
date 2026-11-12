// Stock pages are reached from the Stock menu in the top bar, so there is no tab row here.
export default function StockLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Stock</h1>
      <div className="mt-4">{children}</div>
    </div>
  );
}
