# SuiScope

可部署到 Vercel 的 Sui Move Package 分析器。输入链上 Package ID，即可递归查看依赖、模块 ABI、原始 Bytecode IR，以及从 `.mv` 字节码重建的完整 Move 伪源码（包括 private/internal `fun`）。

## 反编译原则

- 链上 `.mv` 字节码和 Bytecode IR 是唯一语义基准。
- 浏览器端 WASM 从原始模块字节码构建 CFG，不伪造缺失的函数体。
- CFG 使用支配关系、自然循环和分支汇合点恢复 `if/else`、`while`、`break`、`continue`。
- Refinement 会把终止性的 abort 分支恢复为 `assert!`，把跨分支赋值恢复为 Move 合法的 `let x = if (...) { ... } else { ... }`。
- 原始变量名、注释、排版和开发者选择的等价语法已不在字节码中，无法无损恢复；生成代码使用 `arg0`、`v0` 等稳定名称。
- 复杂或不可约控制流仍应与界面中的 **Bytecode IR** 对照，不应把任何高级反编译文本当成源码验证证明。

## 功能

- Mainnet / Testnet / Devnet
- 递归解析直接及传递 Package 依赖
- 展示模块、结构体、公开函数和内部函数
- 完整恢复函数调用、常量、分支、循环、局部值、字段读写和结构体构造
- 下载 `.move` 与 `.mv.disasm`
- 全浏览器 WASM 反编译，无需第三方反编译 API 或 API Key
- 响应式界面，可直接部署到 Vercel

## 本地运行

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>。

质量检查：

```bash
npm test
npm run lint
npm run build
```

## 重新构建 WASM

修订后的 Zig 源码保存在 `vendor/move-decompiler-zig`。使用 Zig 0.15.x：

```bash
cd vendor/move-decompiler-zig
zig build test
zig build wasm
```

然后将 `zig-out/bin/move_decompiler.wasm` 复制到 `public/move_decompiler.wasm`。

本仓库在上游单遍结构化算法之上修复了循环内分支汇合：普通的 join edge 不再被错误打印为 `break`，两个分支也不会重复或吞掉公共后续代码。详见 `vendor/move-decompiler-zig/PATCHES.md`。

## 部署到 Vercel

1. 将仓库推送到 GitHub。
2. 在 Vercel 选择 **Add New → Project** 并导入仓库。
3. Framework Preset 选择 **Next.js**。
4. 点击 **Deploy**。

默认使用公共 Sui 节点。生产流量较大时，可参考 `.env.example` 配置自己的 GraphQL/RPC 节点。

## 数据限制

- 单次分析最多递归 120 个 Package，防止异常依赖图耗尽 Serverless 执行时间。
- 字节码反编译只能恢复可观察执行语义，不能证明与未知原始源码文本一致。
- 要验证重新生成的源码，应使用匹配版本的 Sui Move 编译器重新编译，并逐字节比较生成模块；仅“能够编译”不代表语义一致。
