import { handleSocialPostsApi } from "../../../../../../server/social/postsApi";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleSocialPostsApi(request); }
