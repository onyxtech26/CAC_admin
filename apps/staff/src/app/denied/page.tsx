import { redirect } from "next/navigation";

export default function DeniedPage() {
  redirect("/");
}
