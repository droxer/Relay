import { useQuery } from "@tanstack/react-query";
import { listTags } from "../api-client/tags";

export const TAG_CATALOG_KEY = ["account", "tags"] as const;

export function useTagCatalog() {
  return useQuery({ queryKey: TAG_CATALOG_KEY, queryFn: listTags });
}
