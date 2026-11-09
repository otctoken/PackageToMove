# 逻辑等价与官方源码验证

## 当前结论（2026-11-03）

用户提供的 `0x913188180e04b6291c9621b62b893565274c798bb9d07e67c81417d27cf15a6d`
审计 ZIP 对应 9 个普通包、37 个模块、847 个函数。修复后的审计版和新包版都已实际
构建成功；测试命令通过，但原作者的业务测试不在链上，生成项目的业务测试数量为零。
**尚未完成完整逻辑等价验证，不能承诺所有未来合约都能构建或等价。**

这些数字的含义，以及修复如何作用于其他合约，见 [通用适配与跨项目回归](general-compatibility.md)。

| 检查 | 实测结果 | 可以说明什么 |
| --- | --- | --- |
| Sui 1.82.3 构建两种导出 | 通过 | 当前固定样本能编译 |
| 函数接口、结构体和枚举布局 | 37 模块通过 | 对应接口和布局一致 |
| 原始模块二进制完全相同 | 5/37 | 这 5 个模块的字节恢复一致 |
| 官方 `CompiledModule` 相等判定 | 5/37 | 32 个模块仍有差异 |
| 规范化函数指令完全相同 | 433/847 | 规范化范围内指令相同 |
| 实验性 v2 指令模型额外匹配 | 408/847 | 仅模型覆盖范围内匹配，不含 gas 等 |
| 模型未确认 | 6/847 | 保留失败，不推断等价 |
| 实际逐包官方 `verify-source` | 1/9 包通过 | 8 个包报字节码不匹配 |

官方验证使用显式工具链 `sui 1.82.3-bf4073918ed3`，不声称已找回各包发布时的编译器。
唯一通过的普通包为 `0xe68e5b2ecf310786e6e7681be6c4a1a7fb9ab314d6a9919704415b835baa2248`。
该包仍有 0x1、0x2 只出现在一侧 linkage 表的官方警告；官方返回成功不等于两张表逐项完全相同。
主包失败信息为 `Module orders bytecode does not match its on-chain version`。

剩余 6 个函数：`clearing_house::execute_limit_order`、`clearing_house::execute_market_order`、
`stop_orders::place_stop_order_sltp`、`stop_orders::place_stop_order_standalone`、
`metadata::set_extra_field`、`enum_option::destroy_with_default`。
涉及操作配对、引用别名和枚举解包差异。未确认既不是已证明错误，也不是已证明等价。
上述为 2026-11-03 的历史结果。2026-11-09 已精确恢复 `constants`、`order_id` 的 friend 表，
并移除校验器的空模块例外，详见 [friend 修复记录](friend-events-regression.md)。
旧版函数与完整字节码比较数字不能当作新输出的等价证明。

## MystenLabs 源码核对

固定源码提交为 `bf4073918ed33cfa0b09c500658fa116a774bcfd`，对应实际测试 CLI：

- [官方源代码验证实现 compare.rs](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/crates/sui-source-verification/src/compare.rs)：
  对编译结果修正主包的零地址后比较完整 `CompiledModule` 和模块集合；链接检查比较两侧共有条目，单侧条目给出警告。
- [验证入口 lib.rs](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/crates/sui-source-verification/src/lib.rs)：
  每次验证一个包，依赖需逐包调用；原工具链不可用且没有显式覆盖时会失败。
- [官方构建调用 build.rs](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/crates/sui-source-verification/src/build.rs)：
  使用所选 Sui 工具链构建，包含 `--no-tree-shaking` 和网络参数。
- [VM 指令解释器 eval.rs](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/external-crates/move/crates/move-vm-runtime/src/execution/interpreter/eval.rs)：
  `FreezeRef` 在运行时不改变引用表示，但收取 gas；可变/不可变向量借用的计费参数不同；
  枚举解包检查标签并按声明顺序取字段，标签不符会失败，不能随意删除。
- [字节码验证器说明](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/external-crates/move/crates/move-bytecode-verifier/README.md)：
  栈、类型、资源和引用合法性检查，不是两个程序的业务等价证明。

本轮据此修复 `ReadRef(VecMutBorrow(...))` 的输出，保留 `*(&mut v[i])`，
避免简化成 `v[i]` 后由编译器插入 `FreezeRef` 并改成不可变借用。
已用真实 Sui 编译和反汇编确认区别。枚举恢复还清理了恢复后不再使用的简单局部标签借用，
避免输出重复借用；涉及调用、冻结或其他有作用的表达式不在此清理范围内。
指令模型增加有标签证据的枚举字段引用和分支布局配对，并测试错误字段、错误标签、
条件 abort 的拒绝。模型始终输出 `semanticEquivalenceProven: false`。

## 可执行验证流程

1. 固定链、包对象 ID、版本及全部普通依赖；保存原始字节码、SHA-256、类型起源和 linkage。
   历史审计还需记录 checkpoint、协议版本及系统框架版本。
2. 使用匹配的编译器、edition 和构建配置，构建原地址审计工程。
   保留原权限和布局；不通过添加默认值、删除分支或扩大可见性解决编译错误。
3. 对主包和每个普通依赖运行官方源码验证。失败或无法获取工具链都保持失败。
   单侧 linkage 警告必须保留，不能误写为完整依赖图完全一致。
4. 如果不能恢复相同字节码，必须另行证明两套字节码的行为关系。
   范围包括所有输入和可达状态、分支/循环、整数溢出、abort、引用别名、对象变更、事件、
   外部/native 调用，以及声称涵盖的 gas/资源限制和 VM 版本。
   有限测试、交易重放、覆盖计数和目前的实验性指令模型均不能代替这项完整证明。
5. 新包部署会改变包地址和类型身份。即使原地址验证通过，也要单独验证地址迁移、
   外部协议兼容、初始化和业务测试；不可将原地址结论直接用于新包部署。

```sh
# 两种模式的实际构建、测试日志、friend 检查及离线发布输入；不发送交易
cargo build --bin verify_package --bin compare_project
npm run test:authority-build -- .research/authority-build-check

# 逐函数严格比较：此样本当前仍以非零状态退出
npm run test:authority-roundtrip -- .research/authority-body-check

# 对导出的 audit 工程逐包运行实际官方验证，默认尝试恢复发布工具链
npm run verify:official-source -- <audit-project>
# 或明确指定验证用工具链，不能将其描述成原发布工具链
npm run verify:official-source -- <audit-project> --toolchain <absolute-sui-binary>

# 不接受规范化或空模块 friend 差异的本地模块比较；另需官方 linkage 核对
target/debug/compare_project <chain-bytecode.json> <audit-project>/build <report.json> --require-exact-bytecode
```

`verify:official-source` 保存每包完整日志和 `official-source-validation.json`。
任何失败或超时都会阻止整体通过；全程只读链数据，不发布、不签名、不切换用户环境。
生产 Download All 仍导出待验证工程，不会将覆盖校验冒充实际构建证书。
要保证每个新下载均经过编译，服务端还需逐导出运行隔离的 Sui 构建和验证任务，
把源码/依赖/工具链哈希与结果绑定后才能发放相应证书；当前没有这一服务。
