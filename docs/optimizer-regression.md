# optimizer：37 模块回归

主包：`0x9a47ef4d425ce68377101118acdd60025f4af587f52ebd6df69b824d7d0fa08b`（mainnet）。
报错依赖：`0x817b973d14daa9a20444c8bda8e6e738ad0268817eb35be7dd6755ec61582314::optimizer`。
固定输入在 `tests/fixtures/optimizer-project.json`：主包与 6 个普通依赖，37 模块、1067 函数。
系统依赖使用官方 CLI 框架，不混入根包源码。

## 修复原因

最初的 arithmetic 707/704、comparison 1223/1222 差异来自控制流结构化丢失路径。
内层循环被折叠后，外层仍沿用原始 CFG 的出口；同时，已折叠的无环区域和循环
使用不同的正文映射，导致部分退出路径没有进入最终 AST。现在沿当前剩余图识别
循环，统一保存区域正文，并在最终 AST 上重新核对全部可达代码块。
`loaded_reversal_point` 的 `f6` 调用、退出判断和结果计算均已恢复。

无环区域优先按分支/汇合点重建；跨层向前跳转使用带标签的结构化循环退出，
不复制公共操作。无法用该形式表示的区域仍使用 reaching predicates；仅合成条件
标记可补布尔初值，不给原始业务局部变量填默认值。遗漏/不支持的代码仍触发拒绝。

完整重编译还暴露了三类问题：

- 借用复合表达式及作为运算数的 `if` 缺少括号，可能改变 Move 解析结果，现显式分组。
- 大函数保留过多中间值会超过字节码局部变量限制。现在仅跨越稳定标量和不可变引用
  的读取进行单次内联；保留资源、可变引用、可能写入的变量和短路 RHS 的求值顺序。
- 深层结构化需要更大栈。共享反编译入口使用 32 MiB 工作线程栈，API 的 CPU 工作
  放入阻塞任务池；失败仍作为错误返回。

没有删除原始操作、增加业务返回值或放宽 `fail-closed-v1` 的覆盖门槛。

## 验证

使用 Sui CLI `1.82.3-bf4073918ed3` 本地验证：

| 检查 | 结果 |
| --- | --- |
| 原始字节码校验、完整源码覆盖 | 37/37 |
| 原地址审计版、新包构建版 | 均构建成功 |
| 每个模块的 friend 权限表 | 与对应原始表一致 |
| 原地址重新编译后的字节码验证、接口及数据布局 | 37/37 |
| 规范化函数指令相同 | 550 |
| 限定指令模型匹配 | 517 |
| 未匹配函数 | 0/1067 |
| 离线发布输入 | 仅主包 3 模块，6 个普通依赖保持原链上身份 |
| 原业务测试 | 0；链上不包含 test-only 代码 |

`k5` 检查了 127088 个配对状态。比较器对无后续用途的局部值执行保守活跃性分析，
保留活引用可达的存储；仅复用已保存的不可变条件值的路径事实。完整类型/运算符描述
使用无损驻留表压缩状态键。超过 200000 状态或不支持的指令仍返回 unverified。
比较式翻转及纯值构造允许规范化，但调用、可能 abort 的算术和写操作必须依次匹配。
负例验证了错误算术、返回顺序、分支边界、调用顺序和引用写入仍被拒绝。

复跑已有 efbfd 回归：295/295；modular_bounds 独立模块回归：14/14。
后者并不代表 modular_bounds 所属完整包已构建。
Rust 主库 31 项测试、引擎 37 项测试通过，前端测试、类型检查和生产构建通过。

```sh
cargo build --bin verify_package --bin compare_project
npm run test:optimizer-roundtrip
cargo test --lib
cargo test --manifest-path tests/decompiler-engine/Cargo.toml --lib
npm test
npm run lint
npm run build
```

回归脚本不发布合约、不发送交易。输出目录包含两种项目、构建/测试日志、
validation.json、逐函数原始/重编译指令及其哈希、汇总和工具版本。
任一模块覆盖、构建、权限或指令对照失败均返回非零。

Vercel Function 已在 Ubuntu 24.04、Rust 1.96.1 上通过
`cargo build --locked --target x86_64-unknown-linux-gnu --bin decompile`，
并以 `file` / `readelf` 核对实际链接的 Linux ELF 文件。Linux 主库 31 项和引擎
37 项回归测试全部通过；同次 CI 的前端测试、类型检查及生产构建也通过。
[首次完整 Linux 检查记录](https://github.com/otctoken/PackageToMove/actions/runs/40267262067)。
`.github/workflows/verify.yml` 会在 main、codex 分支推送及 PR 中持续运行这些检查。

## 下载和部署范围

Download All 默认导出新包构建版：根目录 `Move.toml` 和 `sources/` 是主包，
`dependencies/<id>/Move.toml` 和 `sources/` 是各依赖。依赖不合并成根包模块，
避免改变包所有权。`audit/sources/` 保留未迁移视图，`tests/README.md` 提示补充
业务测试，`node verify.mjs` 可重新构建、核对 friend 并执行测试命令。

当前 CLI 需要 `Published.toml` 识别本地依赖的发布身份，仅有 `published-at` 不够。
导出补齐链标识、original-id、published-at 和版本；不伪造原编译器版本或 UpgradeCap。
实时 GraphQL 的完整 base58 链标识转换为 CLI 使用的前 4 字节，并核对分页/依赖链身份。
元数据格式参考 [Sui 官方说明](https://www.docs.sui.io/develop/manage-packages/source-verification)。
新包的 `verify.mjs` 额外执行 `--dump-bytecode-as-base64 --no-tree-shaking`，确认发布
输入仅包含主包模块并引用预期依赖，输出 `publish-input.json`；这一步离线运行、不发送交易。
实际发布仍须在对应网络检查依赖兼容性及初始化前提。

上述结果只针对固定输入与所用工具链。限定指令模型不覆盖 gas、VM 资源限制、
历史框架实现或新包身份变化，`semanticEquivalenceProven` 始终为 false。
新包只迁移主包模块/类型/调用路径，保留地址字面量及依赖身份。已有对象、能力、
初始化前提和依赖发布元数据需要部署前核对。本次未实际发布，不能承诺任意链上合约
都能完全还原为原工程或直接部署。
