import { handleSocialPostsApi } from "../../../../../server/social/postsApi";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return handleSocialPostsApi(request); }
export async function PATCH(request: Request) { return handleSocialPostsApi(request); }
