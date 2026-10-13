import { handleSocialPostsApi } from "../../../../../../server/social/postsApi";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return handleSocialPostsApi(request); }
