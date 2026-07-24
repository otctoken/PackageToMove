# SuiScope

SuiScope 是一个可部署到 Vercel 的 Sui Move Package 分析器。输入链上 Package ID，即可递归解析依赖、浏览模块 ABI，并查看由链上 ABI 与 Move bytecode 重建的可读源码。

## 功能

- Mainnet / Testnet / Devnet
- 递归解析直接和传递 Package 依赖
- 展示模块、结构体和公开函数统计
- 按需完整反编译全部函数，包括 private/internal `fun`
- 还原断言、分支、循环、局部变量、字段读写、结构体构造与跨模块调用
- 完整反编译加载期间显示标准化 ABI 预览
- 查看 Sui GraphQL 返回的原始 bytecode IR
- 一键复制或下载 `.move` / `.mv.disasm`
- 响应式布局，可直接部署至 Vercel

> 链上 Package 不包含原始注释和原始局部变量名，因此反编译器会生成 `arg0`、`v0` 等稳定替代名称。函数逻辑来自链上字节码控制流；需要逐指令核对时，请切换到 **Bytecode IR**。

## 本地运行

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>。

## 部署到 Vercel

1. 将此目录提交并推送到 GitHub。
2. 在 Vercel 中点击 **Add New → Project**，选择该仓库。
3. Framework Preset 选择 **Next.js**，其余保持默认。
4. 点击 **Deploy**。

公共 Sui 节点开箱即用。生产流量较大时，可参考 `.env.example` 将对应的 GraphQL / RPC 地址替换成自己的节点服务。

## 数据与限制

- GraphQL：读取 Package 模块及链上反汇编。
- JSON-RPC：读取标准化 Move ABI。
- 内置 WASM 反编译器：直接在浏览器中从原始 `.mv` 字节码构建 CFG，并恢复包含完整函数体的伪 Move 源码。
- 完整反编译不需要 API Key，也不依赖第三方在线反编译服务。
- API 路由在服务端请求 Sui 节点，避免浏览器跨域限制。
- 单次分析最多递归 120 个 Package，防止异常依赖图耗尽 Serverless 执行时间。
