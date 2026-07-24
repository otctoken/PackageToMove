import { NextRequest, NextResponse } from "next/server";
import { analyzePackage } from "@/lib/sui";
import { Network } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { packageId?: string; network?: Network };
    const network = body.network ?? "mainnet";
    if (!["mainnet", "testnet", "devnet"].includes(network)) {
      return NextResponse.json({ error: "不支持的网络" }, { status: 400 });
    }
    if (!body.packageId) {
      return NextResponse.json({ error: "请输入 Package ID" }, { status: 400 });
    }
    const result = await analyzePackage(body.packageId, network);
    return NextResponse.json(result, {
      headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "分析失败，请稍后重试";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
