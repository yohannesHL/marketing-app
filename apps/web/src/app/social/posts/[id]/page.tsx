import { SocialComposer } from "../../../../components/social/SocialComposer";
export default async function SocialPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SocialComposer postId={id} />;
}
