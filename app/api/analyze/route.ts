import { NextRequest, NextResponse } from "next/server";
import { analyzePackage, getPackagePage } from "@/lib/sui";
import { Network } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { packageId?: string; network?: Network; mode?: string; version?: string; after?: string | null };
    const network = body.network ?? "mainnet";
    if (!["mainnet", "testnet", "devnet"].includes(network)) {
      return NextResponse.json({ error: "不支持的网络" }, { status: 400 });
    }
    if (!body.packageId) {
      return NextResponse.json({ error: "请输入 Package ID" }, { status: 400 });
    }
    if (body.mode != null && body.mode !== "page") throw new Error("无效的分析模式");
    const result = body.mode === "page"
      ? await getPackagePage(body.packageId, network, body.version, body.after, request.signal)
      : await analyzePackage(body.packageId, network);
    // Return our own small JSON error BEFORE the platform replaces the response
    // with a generic text error. Never silently truncate bytecode or modules.
    if (Buffer.byteLength(JSON.stringify(result)) > 4_000_000) {
      return NextResponse.json({ error: "分析响应过大，请刷新页面使用分页分析；未截断模块或合约逻辑" }, { status: 413 });
    }
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "分析失败，请稍后重试";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
