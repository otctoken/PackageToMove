# SuiScope

可部署到 Vercel 的 Sui Move Package 分析器。输入链上 Package ID，即可递归查看依赖、模块 ABI、原始 Bytecode IR，以及从 `.mv` 字节码重建的完整 Move 源码视图（包括 private/internal `fun`）。

## 反编译原则

- 链上 `.mv` 字节码和 Bytecode IR 始终是唯一真相；源码视图不是原始源码证明。
- `/api/decompile` 是 Rust Vercel Function。它自行从 Sui GraphQL `MoveModule.bytes` 获取指定模块，解析并通过官方 Move bytecode verifier 后才反编译，浏览器不能提交任意字节码替换链上输入。
- 主引擎采用固定 Sui commit 的官方 Rust `move-decompiler`，关闭优化，不经过 AI、LLM 或语义润色。
- 反编译尝试重建常量、调用、引用写入、分支、循环和 Abort；覆盖检查是必要条件，不是语义等价证明。已知仍有复杂表达式和历史语言版本无法正确重编译的情况。
- Rust 服务或覆盖检查失败时，前端拒绝输出完整源码，不会降级到未经同等级验证的反编译结果。
- 原始变量名、注释、源码排版和编译前已优化掉的表达式不在字节码中，因此不属于可恢复语义。

## 功能

- Mainnet / Testnet / Devnet
- 递归解析直接及传递 Package 依赖
- 展示模块、结构体、公开函数和内部函数
- 重建函数调用、常量、分支、循环、局部值、字段读写和结构体构造，失败时保留链上反汇编
- 下载 `.move` 与 `.mv.disasm`
- Download All 导出 Move.toml、主包 sources/、dependencies/<包地址>/ 下各依赖的 Move.toml 与 sources/，并附字节码哈希和版本清单。依赖不能混入根包 sources/，否则改变包归属。
- `0x1`～`0x8` 按地址精确跳过反编译，保留依赖元数据；`std`/`sui` 使用 CLI 隐式依赖，`0x3` 使用官方 `system = "sui_system"`。`0x5`～`0x8` 是系统对象，不是包；不为 `0x4` 虚构包配置。
- Rust Vercel Function 主反编译器，完整反编译采用 fail-closed 准入
- 展示字节码 SHA-256、指令、常量、Abort、分支、后向分支、泛型调用和写引用统计
- 不使用 AI 优化模式，不需要第三方反编译 API 或 API Key
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
cargo test --lib
cargo check --target x86_64-unknown-linux-gnu --bin decompile
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

Vercel 会从根目录的 `Cargo.toml` 构建 `api/decompile.rs` Rust Function，同时构建 Next.js 前端。默认使用公共 Sui GraphQL 节点；生产流量较大时，可参考 `.env.example` 配置自己的 GraphQL 服务商节点。

## 数据限制

- GraphQL 使用 `object(address, version) { asMovePackage }` 精确读取包，不使用会追踪升级的 `package(address)`。前后端校验包地址、版本和模块字节码哈希。
- 下载文件是**待验证的重建项目**，不是已验证的可部署产物。manifest.json 明确记录 `buildVerified: false` 和 `semanticEquivalenceVerified: false`。链上不含原作者的测试专用代码。
- 旧方案反编译框架源码有 friend 权限、条件表达式类型、标识符和框架编译属性等构建失败。现改用官方系统依赖，目标 ac55 包的实际导出已构建成功，额外添加的 4 项冒烟测试通过；不能据此承诺所有业务合约等价或可重新部署。不得为了编译通过扩大权限或删除逻辑。
- 本次主网包身份核对和实际构建记录见 [验证报告](docs/exact-package-validation.md)。

- 单次分析最多递归 120 个 Package，防止异常依赖图耗尽 Serverless 执行时间。
- 字节码反编译恢复的是链上指令的可读视图，不能证明文本与未知原始源码一致。
- 要验证重新生成的源码，应使用匹配版本的 Sui Move 编译器重新编译，并逐字节比较生成模块；仅“能够编译”不代表语义一致。
