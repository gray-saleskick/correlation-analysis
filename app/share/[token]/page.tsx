import ShareView from "./ShareView";

export const revalidate = 60; // ISR: cache for 60 seconds

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareView token={token} />;
}
