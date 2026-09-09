import { notFound } from "next/navigation";
import { DesignSystemSpecimen } from "./specimen";

export default function DesignSystemPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <DesignSystemSpecimen />;
}
