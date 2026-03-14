export default function Loading() {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-49px)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/loading.svg"
        alt="Loading…"
        className="w-32 h-32"
        style={{ animation: "sk-loading 1.2s ease-in-out infinite" }}
      />
      <style>{`
        @keyframes sk-loading {
          0%   { opacity: 1;   transform: scale(1); }
          50%  { opacity: 0.6; transform: scale(0.92); }
          100% { opacity: 1;   transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
