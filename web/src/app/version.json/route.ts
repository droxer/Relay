// Written once into the static export as /version.json. An open tab compares
// it with the id it was built with (src/lib/buildFreshness.ts); every host
// serves it revalidating, like the page itself.
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json({ buildId: process.env.NEXT_PUBLIC_RELAY_BUILD_ID ?? "" });
}
