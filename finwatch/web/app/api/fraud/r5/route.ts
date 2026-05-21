import { handleRule } from "@/lib/fraud-handler";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const GET = () => handleRule("R5");
