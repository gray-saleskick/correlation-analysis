export default function TabSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 bg-white/[0.04] rounded-lg w-1/3" />
      <div className="h-4 bg-white/[0.04] rounded w-2/3" />
      <div className="h-4 bg-white/[0.04] rounded w-1/2" />
      <div className="space-y-3 mt-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 bg-white/[0.03] border border-white/[0.06] rounded-xl" />
        ))}
      </div>
    </div>
  );
}
