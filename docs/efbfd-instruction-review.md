# efbfd：56 项指令差异逐项复核

日期：2026-09-09。对象为主网 `0xefbfd064480777699fd9c557a5804d72ace7bc82661fdc8d1f1a44ea6d92ee10` v2，
以及依赖 `0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a` v1。
链上输入固定于 `tests/fixtures/efbfd-{root,dependency}.json`，并按模块校验原始字节码。
没有发布新包、调用业务函数或发送交易。

## 结论与证据层级

- 上一版 56 项差异中，55 项通过了限定指令模型的双程序路径对照。
- 1 项发现真实的反编译**调用顺序保真错误**：`package_utils::set_commited_package`。
  已修复通用内联规则，不是按包地址/函数名写特例。
- 仅修复赋值内联后，295 个函数中 241 个规范化指令完全相同，54 个通过限定模型对照。
  随后增加了下文的通用求值顺序保护；**最终结果为 200 个规范化指令相同、95 个模型匹配、0 个未匹配**。
  新保护保留了更多中间结果，改变了局部变量/指令布局；这不是新增了 41 个已知逻辑错误。
- 原先 `set_authorized_digest` 的无害临时变量消除也不再发生，因此它现在也变成规范化指令完全相同。
  这解释了赋值内联修复阶段的完全相同数量为什么从 239 增至 241，而不是只增加 1。
- 38 个模块均通过正常构建和字节码验证，接口、结构体/枚举布局与 friend ACL 一致。
  Move 测试命令成功，但测试数为 0，不代表业务测试通过。

**不能把上述结果写成“所有合约已被形式化证明与链上完全等价”。**
新检查器是实验性的 `paired-instruction-v1` 翻译验证诊断工具，不是经过独立验证的 Move 语义证明器。
它不比较 gas、内存/栈等资源限制，也不证明当前官方框架实现与历史框架实现一致。
它没有验证新包地址迁移后的业务语义。报告中的 `semanticEquivalenceProven` 仍为 `false`。
生产下载的覆盖检查没有被放宽，也没有用该实验结果替代其拒绝规则。

## 确认修复的调用顺序

`package_utils::set_commited_package` 链上关键指令顺序为：

```text
0  MoveLoc(0)
1  LdFalse
2  Pack PendingPackage
3  Call dynamic_field::borrow_mut<PendingPackage, PackageInfo>
4  StLoc(2)
5  MoveLoc(1)
6  Call package::upgrade_package
7  MoveLoc(2)
8  MutBorrowField PackageInfo.package
9  WriteRef
10 Ret
```

旧输出把 `borrow_mut(...)` 内联进赋值左侧，得到：

```move
*(&mut (dynamic_field::borrow_mut<PendingPackage, PackageInfo>(l0, PendingPackage { dummy_field: false })).package)
    = x2_package::upgrade_package(l1)
```

Move 编译器先求值赋值右侧，再求值目标引用，因此重新编译后变成
`upgrade_package → borrow_mut → WriteRef`。
`collapse_let_usage` 错把 AST `WriteRef` 的第一个参数（目标引用）当成最先求值的参数；
实际最先求值的是第二个参数（待写入值）。修复了只读遍历和替换遍历两处规则。

修复后保留顺序屏障：

```move
let reg_3 = dynamic_field::borrow_mut<PendingPackage, PackageInfo>(l0, PendingPackage { dummy_field: false });
*(&mut reg_3.package) = x2_package::upgrade_package(l1)
```

正常重新编译后该函数的 11 条规范化指令与原始字节码一致。
这里确认的是调用顺序错误，**未声称该特定框架 getter 的顺序变化已造成实际资金损失或可利用漏洞**。
通用反编译器不能假定所有被交换的调用都无副作用、不会 abort。
旧构建送入新检查器会因这一项退出 1，新构建退出 0。

### 同类问题的通用防护

`term_reconstruction` 原先会把单返回值调用、读取和计算缓存成尚未执行的表达式，
直到后续使用点才输出。若中间有无返回值调用、写引用或局部变量重新赋值，就可能延后执行。
现在按指令顺序先绑定结果，再由“下一步最先求值位置”的规则决定是否安全内联。
纯常量、结构体值构造和引用投影可以保留为表达式；其操作数中的读取/调用已被捕获。
这可能增加临时变量，取舍上优先保存逻辑与可能失败操作的顺序。

额外构造的合法 Move 字节码回归覆盖四种情形（不是在第三方链上执行）：

1. 一个返回值调用之后还有无返回值调用，返回先前结果。
2. 除法之后还有调用，除法的可能 abort 不得被延后。
3. 先读引用、再写该引用、返回先前读到的值。
4. 先读取局部变量、再重新赋值、返回先前的值。

第三、四种情况下延后读取会直接改变返回值，因此不只是文本风格问题。

## 逐项清单

下表仅列上次的 56 项，不遗漏依赖函数。
“模型匹配”指保留操作数关联与路径的限定模型匹配，不是单靠操作码/调用计数。
类别说明主要可见差异；完整函数的操作、参数与所有分支仍一并检查。

### 主包：20 项

| 函数 | 主要差异 | 修复后结果 |
|---|---|---|
| actions::upgrade | 多返回值临时变量、断言分支布局 | 模型匹配 |
| actions::update_trusted_signer | 多返回值临时变量、断言分支布局 | 模型匹配 |
| channel::is_real_time | 空枚举分支拆包、临时引用及丢弃 | 模型匹配 |
| channel::is_fixed_rate_50ms | 空枚举分支拆包、临时引用及丢弃 | 模型匹配 |
| channel::is_fixed_rate_200ms | 空枚举分支拆包、临时引用及丢弃 | 模型匹配 |
| channel::get_update_interval_ms | 空枚举分支拆包、临时引用及丢弃 | 模型匹配 |
| feed::parse_from_cursor | 循环条件取反、分支布局、局部变量编号 | 模型匹配 |
| governance::process_incoming | 多返回值临时变量、失败分支后置 | 模型匹配 |
| governance::parse_header | 失败分支后置、跳转布局 | 模型匹配 |
| i16::new | 临时变量消除、字段入栈准备 | 模型匹配 |
| i16::get_magnitude_if_positive | 条件/返回分支布局 | 模型匹配 |
| i16::get_magnitude_if_negative | 条件/返回分支布局 | 模型匹配 |
| i64::new | 临时变量消除、字段入栈准备 | 模型匹配 |
| i64::get_magnitude_if_positive | 条件/返回分支布局 | 模型匹配 |
| i64::get_magnitude_if_negative | 条件/返回分支布局 | 模型匹配 |
| pyth_lazer::verify_le_ecdsa_message | 条件/循环布局与局部值流 | 模型匹配 |
| pyth_lazer::parse_and_verify_le_ecdsa_update_v2 | 条件/循环布局与局部值流 | 模型匹配 |
| state::share | 临时变量与局部值流 | 模型匹配 |
| state::update_trusted_signer | 条件/循环布局与局部值流 | 模型匹配 |
| update_v2::parse_from_cursor | 局部变量编号与值流 | 模型匹配 |

### 普通依赖：36 项

| 函数 | 主要差异 | 修复后结果 |
|---|---|---|
| bytes::take_bytes | 局部值流/控制流布局 | 模型匹配 |
| bytes20::default | 局部值流/控制流布局 | 模型匹配 |
| bytes20::is_nonzero | 局部值流/控制流布局 | 模型匹配 |
| bytes20::pad_left | 局部值流/控制流布局 | 模型匹配 |
| bytes20::trim_nonzero_left | 局部值流/控制流布局 | 模型匹配 |
| bytes32::default | 局部值流/控制流布局 | 模型匹配 |
| bytes32::from_utf8 | 局部值流/控制流布局 | 模型匹配 |
| bytes32::is_nonzero | 局部值流/控制流布局 | 模型匹配 |
| bytes32::pad_left | 局部值流/控制流布局 | 模型匹配 |
| bytes32::trim_nonzero_left | 局部值流/控制流布局 | 模型匹配 |
| emitter::destroy | 拆包后临时变量与丢弃 | 模型匹配 |
| fee_collector::deposit_balance | 失败分支布局；join 返回值仍丢弃 | 模型匹配 |
| governance_message::take_payload | 拆包后临时变量与丢弃 | 模型匹配 |
| governance_message::destroy | 拆包后临时变量与丢弃 | 模型匹配 |
| governance_message::verify_vaa | 局部值流/控制流布局 | 模型匹配 |
| guardian::ecrecover | 局部值流/控制流布局 | 模型匹配 |
| guardian_set::new | 局部值流/控制流布局 | 模型匹配 |
| guardian_signature::to_rsv | 多返回值临时变量与丢弃 | 模型匹配 |
| migrate::handle_migrate | 局部值流/控制流布局 | 模型匹配 |
| package_utils::assert_package_upgrade_cap | 条件取反及控制流布局 | 模型匹配 |
| package_utils::set_commited_package | **调用顺序保真错误，已修复** | **规范化指令相同** |
| package_utils::set_authorized_digest | 目标引用的临时变量内联 | **规范化指令相同** |
| package_utils::update_version_type | 断言取反、控制流布局 | 模型匹配 |
| publish_message::publish_message | 多返回值临时变量 | 模型匹配 |
| set::add | 断言与跳转布局 | 模型匹配 |
| set::remove | 断言与跳转布局；移除返回值仍丢弃 | 模型匹配 |
| setup::complete | 局部变量编号 | 模型匹配 |
| state::new | 失败分支后置、局部变量编号 | 模型匹配 |
| update_guardian_set::handle_update_guardian_set | 失败分支后置、局部变量编号 | 模型匹配 |
| update_guardian_set::deserialize | 循环跳转简化 | 模型匹配 |
| vaa::take_payload | 多返回值临时变量与丢弃 | 模型匹配 |
| vaa::take_emitter_info_and_payload | 结构体字段拆包后的临时变量与丢弃 | 模型匹配 |
| vaa::parse_and_verify | 多返回值临时变量 | 模型匹配 |
| vaa::compute_message_hash | 空 vector 的 VecPack 与 LdConst 表示 | 模型匹配 |
| vaa::parse | 临时变量消除、循环跳转简化 | 模型匹配 |
| vaa::verify_signatures | 条件取反与断言/循环布局 | 模型匹配 |

空 vector 的常量 BCS 数据 `[0]` 是“长度为零”，不是包含一个零元素。
枚举的空拆包只有在相同不可变值已由 VariantSwitch 确认同一 variant 时才允许忽略；
不能对任意 UnpackVariant 这样处理，它可能因标签不匹配而失败。

## 检查器与回归

`src/body_compare.rs` 对规范化字节码做双程序符号路径对照：

- 解析模块、函数、类型参数和字段身份，不比较容易变动的表索引。
- 跟踪操作数栈、局部变量、引用单元关联和多返回值位置。
- 保留调用、算术、转换、读写引用、vector 操作的顺序；不交换调用或浮动算术。
- 纯结构体 Pack 使用带完整类型/字段顺序的值树比较，允许编译器移动无用户构造函数的值构造。
  不允许改变字段值；构造所需的调用与读取仍逐项比较。支持 u256 的立即数/BCS 常量一致化。
- 比较返回值、abort 码，探索条件分支的两侧；只处理明确的布尔互补。
- 循环用联合符号状态复现检查，不以固定次数抽样宣称匹配。
- 不支持的指令、不同操作/值流、引用关联冲突、超出状态预算均返回未验证。
- CLI 在未验证、缺失模块、重复冲突模块、接口/布局/ACL 差异时返回非零。

新增有效 Move 字节码的正负向测试：临时变量/丢弃、分支互补、改变 abort 码、
改变分支方向、改变运算符、交换除法操作数、改变写入值、改变引用写入目标、
交换元组返回值、改变循环边界、交换两个不同调用。
真实旧构建也作为负向实验被拒绝，不依赖人为标注函数白名单。

运行完整真实编译回归：

```sh
cargo test --lib
cargo build --bin verify_package --bin compare_project
npm run test:roundtrip
```

它生成全新目录（不覆盖旧结果），从固定链上输入重新反编译 38 个模块，运行
Sui build、friend ACL 检查、Sui test、再一次非测试构建，以及所有 295 个函数的对照。
输出 `instruction-root.json`、`instruction-dependency.json`、`instruction-summary.json`，
含每个函数状态、原始/重编译模块 SHA-256，以及不同函数的双方规范化指令。
同时保留链上输入 JSON、构建日志和 source/manifest 输入哈希。

通用 CLI 也接受其他同结构的精确链上包 JSON 与其正常重编译目录：

```sh
compare_project exact-package.json project/build instruction-report.json
```

这是一道额外检查，不是“以后任何包都无需审核”的保证。对尚未经过此回归的包，
网页上的基础覆盖检查仍不能当作函数体语义等价结论。
