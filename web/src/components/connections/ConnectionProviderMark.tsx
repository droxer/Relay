import Image from "next/image";
import { GithubMark } from "../landing/GithubMark";

interface Props {
  provider: string;
  size: number;
  className?: string;
}

export function ConnectionProviderMark({ provider, size, className }: Props) {
  if (provider === "github") return <GithubMark size={size} className={className} />;
  if (provider !== "gmail" && provider !== "outlook") return null;

  return <Image src={`/brand/${provider}.svg`} alt="" width={size} height={size}
    className={className} style={{ objectFit: "contain" }} unoptimized />;
}
