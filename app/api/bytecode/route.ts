import { NextRequest, NextResponse } from "next/server";
import { getMoveModuleBytecode } from "@/lib/bytecode";
import { Network } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      packageId?: string;
      module?: string;
      network?: Network;
    };
    const network = body.network ?? "mainnet";
    if (!["mainnet", "testnet", "devnet"].includes(network)) {
      return NextResponse.json({ error: "不支持的网络" }, { status: 400 });
    }
    if (!body.packageId || !body.module) {
      return NextResponse.json(
        { error: "缺少 Package ID 或模块名" },
        { status: 400 },
      );
    }
    const result = await getMoveModuleBytecode(
      body.packageId,
      body.module,
      network,
    );
    return NextResponse.json(result, {
      headers: {
        "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "读取模块字节码失败，请稍后重试";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
