//! Conservative, paired symbolic translation validation. No contract execution.
//!
//! This is deliberately NOT a Move semantic-equivalence oracle. It matches every
//! effect/possibly-aborting operation in order, with its resolved operands, and
//! explores both sides of each conditional. Only local shuffling, legal drops,
//! branch layout, total boolean complements and identical constant encodings are
//! abstracted. Gas, dependency implementation and VM resource limits are outside
//! this model. Unsupported instructions or a state budget produce Unverified.
//! Pure struct Pack is a typed value tree (no user constructors/destructors).
use move_binary_format::{
    file_format::JumpTableInner,
    normalized::{Bytecode as B, Function, RcIdentifier, Type},
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
enum V {
    Atom(u32, Vec<usize>),
    Lit(String),
    Cell(usize),
    Expr(String, Vec<V>),
}
fn not(v: V) -> V {
    match v {
        V::Expr(op, mut args) if op == "Not" => args.remove(0),
        V::Lit(s) if s == "Bool:01" => V::Lit("Bool:00".into()),
        V::Lit(s) if s == "Bool:00" => V::Lit("Bool:01".into()),
        v => V::Expr("Not".into(), vec![v]),
    }
}
fn literal(ty: impl std::fmt::Debug, bytes: &[u8]) -> V {
    V::Lit(format!(
        "{ty:?}:{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
fn cells(v: &V, out: &mut BTreeSet<usize>) {
    match v {
        V::Cell(i) => {
            out.insert(*i);
        }
        V::Atom(_, deps) => out.extend(deps),
        V::Expr(_, vs) => {
            for v in vs {
                cells(v, out)
            }
        }
        _ => (),
    }
}
#[derive(Debug, Clone)]
struct State {
    pc: usize,
    locals: Vec<Option<V>>,
    stack: Vec<V>,
    // A cell's location in this function. Shared cell ids preserve aliasing.
    cell_locals: Vec<usize>,
    variants: Vec<(V, String, String)>,
}
impl State {
    fn new(f: &Function<RcIdentifier>) -> Self {
        let mut locals = vec![None; f.parameters.len() + f.locals.len()];
        for (i, l) in locals.iter_mut().take(f.parameters.len()).enumerate() {
            *l = Some(V::Atom(i as u32, vec![]));
        }
        Self {
            pc: 0,
            locals,
            stack: vec![],
            cell_locals: vec![],
            variants: vec![],
        }
    }
    fn args(&mut self, n: usize) -> Result<Vec<V>, String> {
        if self.stack.len() < n {
            return Err("Stack underflow".into());
        }
        Ok(self.stack.split_off(self.stack.len() - n))
    }
    fn value(&self, i: usize) -> Result<V, String> {
        self.locals
            .get(i)
            .and_then(Clone::clone)
            .ok_or_else(|| format!("Unavailable local {i}"))
    }
}
#[derive(Debug)]
enum Stop {
    Op {
        key: String,
        args: Vec<V>,
        outputs: usize,
        refs: Vec<bool>,
        mutates: bool,
    },
    Borrow {
        local: usize,
        mutable: bool,
        ty: String,
        value: V,
    },
    Cond {
        value: V,
        yes: usize,
        no: usize,
    },
    Switch {
        value: V,
        key: String,
        arms: Vec<(String, usize)>,
    },
    End {
        key: String,
        args: Vec<V>,
    },
}
fn advance(s: &mut State, f: &Function<RcIdentifier>) -> Result<Stop, String> {
    for _ in 0..10000 {
        let pc = s.pc;
        let op = f.code().get(pc).ok_or("Control flow outside code")?;
        s.pc += 1;
        let (inputs, outputs, mutates) = match op {
            B::Nop => continue,
            B::Branch(t) => {
                s.pc = *t as usize;
                continue;
            }
            B::CopyLoc(i) => {
                s.stack.push(s.value(*i as usize)?);
                continue;
            }
            B::MoveLoc(i) => {
                s.stack.push(s.value(*i as usize)?);
                s.locals[*i as usize] = None;
                continue;
            }
            B::StLoc(i) => {
                s.locals[*i as usize] = Some(s.args(1)?.remove(0));
                continue;
            }
            B::Pop => {
                s.args(1)?;
                continue;
            }
            B::LdConst(c) => {
                s.stack.push(literal(&c.type_, &c.data));
                continue;
            }
            B::LdTrue | B::LdFalse => {
                s.stack.push(literal(
                    Type::<RcIdentifier>::Bool,
                    &[u8::from(matches!(op, B::LdTrue))],
                ));
                continue;
            }
            B::LdU8(n) => {
                s.stack
                    .push(literal(Type::<RcIdentifier>::U8, &n.to_le_bytes()));
                continue;
            }
            B::LdU16(n) => {
                s.stack
                    .push(literal(Type::<RcIdentifier>::U16, &n.to_le_bytes()));
                continue;
            }
            B::LdU32(n) => {
                s.stack
                    .push(literal(Type::<RcIdentifier>::U32, &n.to_le_bytes()));
                continue;
            }
            B::LdU64(n) => {
                s.stack
                    .push(literal(Type::<RcIdentifier>::U64, &n.to_le_bytes()));
                continue;
            }
            B::LdU128(n) => {
                s.stack
                    .push(literal(Type::<RcIdentifier>::U128, &n.to_le_bytes()));
                continue;
            }
            B::LdU256(n) => {
                s.stack
                    .push(literal(Type::<RcIdentifier>::U256, &n.to_le_bytes()));
                continue;
            }
            B::Pack(p) => {
                // No user constructor/destructor: retain layout and field values
                // as a typed tree. Field evaluation effects were already matched.
                // Allocation costs/VM limits are outside this model.
                let args = s.args(p.struct_.fields.0.len())?;
                s.stack.push(V::Expr(format!("{op:?}"), args));
                continue;
            }
            B::VecPack(p) if p.1 == 0 => {
                s.stack
                    .push(literal(Type::Vector(Box::new((*p.0).clone())), &[0]));
                continue;
            }
            B::Not => {
                let v = s.args(1)?.remove(0);
                s.stack.push(not(v));
                continue;
            }
            B::Eq | B::Neq | B::Lt | B::Ge | B::Gt | B::Le => {
                let args = s.args(2)?;
                let key = match op {
                    B::Eq | B::Neq => "Eq",
                    B::Lt | B::Ge => "Lt",
                    _ => "Gt",
                };
                let v = V::Expr(key.into(), args);
                s.stack.push(if matches!(op, B::Neq | B::Ge | B::Le) {
                    not(v)
                } else {
                    v
                });
                continue;
            }
            B::BrTrue(t) | B::BrFalse(t) => {
                let value = s.args(1)?.remove(0);
                let (yes, no) = if matches!(op, B::BrTrue(_)) {
                    (*t as usize, s.pc)
                } else {
                    (s.pc, *t as usize)
                };
                if let V::Lit(v) = &value {
                    if v == "Bool:01" || v == "Bool:00" {
                        s.pc = if v == "Bool:01" { yes } else { no };
                        continue;
                    }
                }
                return Ok(Stop::Cond { value, yes, no });
            }
            B::MutBorrowLoc(i) | B::ImmBorrowLoc(i) => {
                let i = *i as usize;
                let ty = f
                    .parameters
                    .iter()
                    .chain(f.locals.iter())
                    .nth(i)
                    .ok_or("Bad local type")?;
                return Ok(Stop::Borrow {
                    local: i,
                    mutable: matches!(op, B::MutBorrowLoc(_)),
                    ty: format!("{ty:?}"),
                    value: s.value(i)?,
                });
            }
            B::FreezeRef | B::MutBorrowField(_) | B::ImmBorrowField(_) => {
                let args = s.args(1)?;
                s.stack.push(V::Expr(format!("{op:?}"), args));
                continue;
            }
            B::VariantSwitch(t) => {
                let JumpTableInner::Full(targets) = &t.jump_table;
                return Ok(Stop::Switch {
                    value: s.args(1)?.remove(0),
                    key: format!("{:?}", t.enum_),
                    arms: t
                        .enum_
                        .variants
                        .keys()
                        .zip(targets)
                        .map(|(n, t)| (n.to_string(), *t as usize))
                        .collect(),
                });
            }
            B::UnpackVariantImmRef(v) if v.variant.fields.0.is_empty() => {
                let value = s.args(1)?.remove(0);
                // This instruction can abort on the wrong tag. Elide ONLY after
                // the same immutable value has been switched to this exact tag.
                if s.variants.contains(&(
                    value,
                    format!("{:?}", v.enum_),
                    v.variant.name.to_string(),
                )) {
                    continue;
                }
                return Err(format!("Unproven empty variant unpack at {pc}"));
            }
            B::Ret => {
                let args = s.args(f.return_.len())?;
                if !s.stack.is_empty() {
                    return Err("Extra return operands".into());
                }
                return Ok(Stop::End {
                    key: "Ret".into(),
                    args,
                });
            }
            B::Abort => {
                return Ok(Stop::End {
                    key: "Abort".into(),
                    args: s.args(1)?,
                })
            }
            B::Call(c) => {
                return Ok(Stop::Op {
                    key: format!("{op:?}"),
                    args: s.args(c.parameters.len())?,
                    outputs: c.return_.len(),
                    refs: c
                        .return_
                        .iter()
                        .map(|t| matches!(**t, Type::Reference(..)))
                        .collect(),
                    mutates: true,
                })
            }
            B::Unpack(p) => (1, p.struct_.fields.0.len(), false),
            B::ReadRef => (1, 1, false),
            B::WriteRef => (2, 0, true),
            B::Add
            | B::Sub
            | B::Mul
            | B::Div
            | B::Mod
            | B::Shl
            | B::Shr
            | B::BitOr
            | B::BitAnd
            | B::Xor
            | B::And
            | B::Or => (2, 1, false),
            B::CastU8 | B::CastU16 | B::CastU32 | B::CastU64 | B::CastU128 | B::CastU256 => {
                (1, 1, false)
            }
            B::VecPack(p) => (
                p.1.try_into().map_err(|_| "Vector arity overflow")?,
                1,
                false,
            ),
            B::VecLen(_) => (1, 1, false),
            B::VecImmBorrow(_) | B::VecMutBorrow(_) => (2, 1, false),
            B::VecPushBack(_) => (2, 0, true),
            B::VecPopBack(_) => (1, 1, true),
            B::VecUnpack(p) => (
                1,
                p.1.try_into().map_err(|_| "Vector arity overflow")?,
                false,
            ),
            B::VecSwap(_) => (3, 0, true),
            _ => return Err(format!("Unsupported instruction at {pc}: {op:?}")),
        };
        return Ok(Stop::Op {
            key: format!("{op:?}"),
            args: s.args(inputs)?,
            outputs,
            refs: vec![matches!(op, B::VecImmBorrow(_) | B::VecMutBorrow(_)); outputs],
            mutates,
        });
    }
    Err("Administrative instruction budget exceeded".into())
}
// State key alpha-renames *jointly*, retaining every cross-program correlation.
// No branch is sampled/unrolled a fixed number of times and declared equivalent.
fn state_key(a: &State, b: &State) -> String {
    fn val(v: &V, ids: &mut BTreeMap<u32, usize>) -> String {
        match v {
            V::Atom(i, deps) => {
                let next = ids.len();
                let n = *ids.entry(*i).or_insert(next);
                format!("a{n}:{deps:?}")
            }
            V::Lit(s) => format!("l{s:?}"),
            V::Cell(i) => format!("c{i}"),
            V::Expr(op, args) => format!(
                "e{op:?}{:?}",
                args.iter().map(|v| val(v, ids)).collect::<Vec<_>>()
            ),
        }
    }
    let mut ids = BTreeMap::new();
    let mut parts = vec![];
    for s in [a, b] {
        parts.push(format!("{}:{:?}", s.pc, s.cell_locals));
        for l in &s.locals {
            parts.push(
                l.as_ref()
                    .map(|v| val(v, &mut ids))
                    .unwrap_or("none".into()),
            )
        }
        parts.push(format!(
            "stack:{:?}",
            s.stack.iter().map(|v| val(v, &mut ids)).collect::<Vec<_>>()
        ));
        for (v, e, n) in &s.variants {
            parts.push(format!("{}:{e}:{n}", val(v, &mut ids)))
        }
    }
    format!("{parts:?}")
}
fn matching_memory(x: &State, y: &State, values: &[V]) -> Result<BTreeSet<usize>, String> {
    let mut pending = BTreeSet::new();
    for value in values {
        cells(value, &mut pending)
    }
    let mut checked = BTreeSet::new();
    while let Some(c) = pending.pop_first() {
        if !checked.insert(c) {
            continue;
        }
        let a = x
            .cell_locals
            .get(c)
            .and_then(|i| x.locals.get(*i))
            .ok_or("Unknown original reference cell")?;
        let b = y
            .cell_locals
            .get(c)
            .and_then(|i| y.locals.get(*i))
            .ok_or("Unknown rebuilt reference cell")?;
        if a != b {
            return Err("Referenced local contents differ".into());
        }
        if let Some(value) = a {
            cells(value, &mut pending)
        }
    }
    Ok(checked)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyComparison {
    pub status: &'static str,
    pub paired_states: usize,
    pub reason: String,
}
/// Both enclosing modules MUST have passed the Move bytecode verifier and their
/// layouts/ACLs must be compared separately. A match is a restricted diagnostic,
/// not permission to bypass the production coverage gate.
pub fn compare(a: &Function<RcIdentifier>, b: &Function<RcIdentifier>) -> BodyComparison {
    let mut count = 0;
    let result = (|| -> Result<(), String> {
        if a.parameters != b.parameters
            || a.return_ != b.return_
            || a.type_parameters != b.type_parameters
            || a.visibility != b.visibility
            || a.is_entry != b.is_entry
        {
            return Err("Function interface differs".into());
        }
        if a.code().is_empty() || b.code().is_empty() {
            return Err("Native/empty body needs separate verification".into());
        }
        let mut queue = vec![(State::new(a), State::new(b))];
        let mut seen = HashSet::new();
        let mut fresh = a.parameters.len() as u32;
        while let Some((mut x, mut y)) = queue.pop() {
            if !seen.insert(state_key(&x, &y)) {
                continue;
            }
            count += 1;
            if count > 20000 {
                return Err("Paired-state budget exceeded".into());
            }
            let before = (x.pc, y.pc);
            let sx = advance(&mut x, a)?;
            let sy = advance(&mut y, b)?;
            match (sx, sy) {
                (Stop::End { key: k, args: xs }, Stop::End { key: l, args: ys })
                    if k == l && xs == ys =>
                {
                    matching_memory(&x, &y, &xs)?;
                }
                (
                    Stop::Cond {
                        value: v,
                        yes: t,
                        no: f,
                    },
                    Stop::Cond {
                        value: w,
                        yes: u,
                        no: g,
                    },
                ) => {
                    let (u, g) = if v == w {
                        (u, g)
                    } else if v == not(w) {
                        (g, u)
                    } else {
                        return Err(format!("Condition operands differ near {before:?}"));
                    };
                    let (mut xt, mut yt) = (x.clone(), y.clone());
                    xt.pc = t;
                    yt.pc = u;
                    queue.push((xt, yt));
                    x.pc = f;
                    y.pc = g;
                    queue.push((x, y));
                }
                (
                    Stop::Switch {
                        value: v,
                        key: k,
                        arms: xs,
                    },
                    Stop::Switch {
                        value: w,
                        key: l,
                        arms: ys,
                    },
                ) if v == w && k == l && xs.len() == ys.len() => {
                    for ((n, t), (m, u)) in xs.into_iter().zip(ys) {
                        if n != m {
                            return Err("Variant tag order changed".into());
                        }
                        let (mut xt, mut yt) = (x.clone(), y.clone());
                        xt.pc = t;
                        yt.pc = u;
                        xt.variants.push((v.clone(), k.clone(), n.clone()));
                        yt.variants.push((w.clone(), l.clone(), m));
                        queue.push((xt, yt));
                    }
                }
                (
                    Stop::Borrow {
                        local: i,
                        mutable: m,
                        ty: t,
                        value: v,
                    },
                    Stop::Borrow {
                        local: j,
                        mutable: n,
                        ty: u,
                        value: w,
                    },
                ) if m == n && t == u && v == w => {
                    let ci = x.cell_locals.iter().position(|p| *p == i);
                    let cj = y.cell_locals.iter().position(|p| *p == j);
                    let cell = match (ci, cj) {
                        (Some(p), Some(q)) if p == q => p,
                        (None, None) => {
                            let c = x.cell_locals.len();
                            x.cell_locals.push(i);
                            y.cell_locals.push(j);
                            c
                        }
                        _ => return Err(format!("Local reference alias differs near {before:?}")),
                    };
                    let v = V::Expr(
                        if m { "MutRef" } else { "ImmRef" }.into(),
                        vec![V::Cell(cell)],
                    );
                    x.stack.push(v.clone());
                    y.stack.push(v);
                    queue.push((x, y));
                }
                (
                    Stop::Op {
                        key: k,
                        args: xs,
                        outputs: n,
                        refs: r,
                        mutates: m,
                    },
                    Stop::Op {
                        key: l,
                        args: ys,
                        outputs: o,
                        refs: s,
                        mutates: p,
                    },
                ) if k == l && xs == ys && n == o && r == s && m == p => {
                    // Validate contents before abstracting a callee's effect. Never
                    // erase different local state behind an otherwise equal ref.
                    let deps =
                        matching_memory(&x, &y, &xs).map_err(|e| format!("{e} near {before:?}"))?;
                    if m {
                        for c in &deps {
                            let v = V::Atom(fresh, vec![]);
                            fresh += 1;
                            x.locals[x.cell_locals[*c]] = Some(v.clone());
                            y.locals[y.cell_locals[*c]] = Some(v);
                        }
                        x.variants.clear();
                        y.variants.clear();
                    }
                    for is_ref in r {
                        let v = V::Atom(
                            fresh,
                            if is_ref {
                                deps.iter().copied().collect()
                            } else {
                                vec![]
                            },
                        );
                        fresh += 1;
                        x.stack.push(v.clone());
                        y.stack.push(v);
                    }
                    queue.push((x, y));
                }
                (sx, sy) => {
                    return Err(format!(
                        "Unmatched operation near {before:?}: {sx:?} versus {sy:?}"
                    ))
                }
            }
        }
        Ok(())
    })();
    match result {
        Ok(())=>BodyComparison{status:"matched-under-model",paired_states:count,reason:"All paired paths matched under conservative instruction model v1; excludes gas, resource limits and dependency implementations".into()},
        Err(reason)=>BodyComparison{status:"unverified",paired_states:count,reason},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use move_binary_format::{
        file_format::{self as ff, Bytecode as I, SignatureToken as T},
        normalized::{Module, RcPool},
    };

    fn module(params: Vec<T>, returns: Vec<T>, locals: Vec<T>, code: Vec<I>) -> ff::CompiledModule {
        let mut m = ff::basic_test_module();
        let mut indices = vec![];
        for types in [params, returns, locals] {
            let sig = ff::Signature(types);
            let i = if let Some(i) = m.signatures.iter().position(|s| s == &sig) {
                i
            } else {
                m.signatures.push(sig);
                m.signatures.len() - 1
            };
            indices.push(ff::SignatureIndex(i as u16));
        }
        m.function_handles[0].parameters = indices[0];
        m.function_handles[0].return_ = indices[1];
        let body = m.function_defs[0].code.as_mut().unwrap();
        body.locals = indices[2];
        body.code = code;
        move_bytecode_verifier::verify_module_unmetered(&m)
            .expect("Test must use valid Move bytecode");
        m
    }
    fn check(a: ff::CompiledModule, b: ff::CompiledModule, matched: bool) {
        let mut pool = RcPool::new();
        let a = Module::new(&mut pool, &a, true);
        let b = Module::new(&mut pool, &b, true);
        let result = compare(
            a.functions.values().next().unwrap(),
            b.functions.values().next().unwrap(),
        );
        assert_eq!(
            result.status == "matched-under-model",
            matched,
            "{result:?}"
        );
    }
    #[test]
    fn harmless_local_shuffle_and_discard() {
        check(
            module(
                vec![T::U64],
                vec![T::U64],
                vec![T::U64],
                vec![
                    I::CopyLoc(0),
                    I::StLoc(1),
                    I::MoveLoc(0),
                    I::Pop,
                    I::MoveLoc(1),
                    I::Ret,
                ],
            ),
            module(
                vec![T::U64],
                vec![T::U64],
                vec![],
                vec![I::MoveLoc(0), I::Ret],
            ),
            true,
        );
    }
    #[test]
    fn changed_arithmetic_or_operand_order_is_not_a_compiler_difference() {
        let a = module(
            vec![T::U64, T::U64],
            vec![T::U64],
            vec![],
            vec![I::MoveLoc(0), I::MoveLoc(1), I::Div, I::Ret],
        );
        check(
            a.clone(),
            module(
                vec![T::U64, T::U64],
                vec![T::U64],
                vec![],
                vec![I::MoveLoc(1), I::MoveLoc(0), I::Div, I::Ret],
            ),
            false,
        );
        check(
            a,
            module(
                vec![T::U64, T::U64],
                vec![T::U64],
                vec![],
                vec![I::MoveLoc(0), I::MoveLoc(1), I::Mul, I::Ret],
            ),
            false,
        );
    }
    #[test]
    fn branch_complement_must_preserve_abort_path_and_code() {
        let a = module(
            vec![T::Bool],
            vec![T::U64],
            vec![],
            vec![
                I::MoveLoc(0),
                I::BrFalse(4),
                I::LdU64(8),
                I::Ret,
                I::LdU64(3),
                I::Abort,
            ],
        );
        let b = module(
            vec![T::Bool],
            vec![T::U64],
            vec![],
            vec![
                I::MoveLoc(0),
                I::Not,
                I::BrTrue(5),
                I::LdU64(8),
                I::Ret,
                I::LdU64(3),
                I::Abort,
            ],
        );
        check(a.clone(), b, true);
        check(
            a.clone(),
            module(
                vec![T::Bool],
                vec![T::U64],
                vec![],
                vec![
                    I::MoveLoc(0),
                    I::BrTrue(4),
                    I::LdU64(8),
                    I::Ret,
                    I::LdU64(3),
                    I::Abort,
                ],
            ),
            false,
        );
        check(
            a,
            module(
                vec![T::Bool],
                vec![T::U64],
                vec![],
                vec![
                    I::MoveLoc(0),
                    I::BrFalse(4),
                    I::LdU64(8),
                    I::Ret,
                    I::LdU64(4),
                    I::Abort,
                ],
            ),
            false,
        );
    }
    #[test]
    fn write_value_and_reference_target_are_checked() {
        let params = vec![
            T::MutableReference(Box::new(T::U64)),
            T::MutableReference(Box::new(T::U64)),
        ];
        let a = module(
            params.clone(),
            vec![],
            vec![],
            vec![
                I::LdU64(1),
                I::MoveLoc(0),
                I::WriteRef,
                I::MoveLoc(1),
                I::Pop,
                I::Ret,
            ],
        );
        check(
            a.clone(),
            module(
                params.clone(),
                vec![],
                vec![],
                vec![
                    I::LdU64(2),
                    I::MoveLoc(0),
                    I::WriteRef,
                    I::MoveLoc(1),
                    I::Pop,
                    I::Ret,
                ],
            ),
            false,
        );
        check(
            a,
            module(
                params,
                vec![],
                vec![],
                vec![
                    I::LdU64(1),
                    I::MoveLoc(1),
                    I::WriteRef,
                    I::MoveLoc(0),
                    I::Pop,
                    I::Ret,
                ],
            ),
            false,
        );
    }
    #[test]
    fn return_tuple_order_matters() {
        check(
            module(
                vec![T::U64, T::U64],
                vec![T::U64, T::U64],
                vec![],
                vec![I::MoveLoc(0), I::MoveLoc(1), I::Ret],
            ),
            module(
                vec![T::U64, T::U64],
                vec![T::U64, T::U64],
                vec![],
                vec![I::MoveLoc(1), I::MoveLoc(0), I::Ret],
            ),
            false,
        );
    }
    #[test]
    fn loop_bounds_are_not_ignored() {
        let code = vec![
            I::LdU64(0),
            I::StLoc(1),
            I::CopyLoc(1),
            I::CopyLoc(0),
            I::Lt,
            I::BrFalse(11),
            I::MoveLoc(1),
            I::LdU64(1),
            I::Add,
            I::StLoc(1),
            I::Branch(2),
            I::MoveLoc(1),
            I::Ret,
        ];
        let a = module(vec![T::U64], vec![T::U64], vec![T::U64], code.clone());
        let mut b = code.clone();
        b[4] = I::Ge;
        b[5] = I::BrTrue(11);
        check(
            a.clone(),
            module(vec![T::U64], vec![T::U64], vec![T::U64], b),
            true,
        );
        let mut b = code;
        b[4] = I::Le;
        check(
            a,
            module(vec![T::U64], vec![T::U64], vec![T::U64], b),
            false,
        );
    }
    #[test]
    fn call_order_is_never_commuted() {
        // Two distinct opaque native callees with the same signature.
        let mut a = module(
            vec![T::U64],
            vec![T::U64],
            vec![],
            vec![I::MoveLoc(0), I::Ret],
        );
        for name in [2, 3] {
            let mut handle = a.function_handles[0].clone();
            handle.name = ff::IdentifierIndex(name);
            a.function_handles.push(handle);
            a.function_defs.push(ff::FunctionDefinition {
                function: ff::FunctionHandleIndex((a.function_handles.len() - 1) as u16),
                visibility: ff::Visibility::Private,
                is_entry: false,
                acquires_global_resources: vec![],
                code: None,
            });
        }
        a.function_defs[0].code.as_mut().unwrap().code = vec![
            I::MoveLoc(0),
            I::Call(ff::FunctionHandleIndex(1)),
            I::Call(ff::FunctionHandleIndex(2)),
            I::Ret,
        ];
        let mut b = a.clone();
        b.function_defs[0].code.as_mut().unwrap().code = vec![
            I::MoveLoc(0),
            I::Call(ff::FunctionHandleIndex(2)),
            I::Call(ff::FunctionHandleIndex(1)),
            I::Ret,
        ];
        move_bytecode_verifier::verify_module_unmetered(&a).unwrap();
        move_bytecode_verifier::verify_module_unmetered(&b).unwrap();
        check(a, b, false);
    }

    fn source(m: &ff::CompiledModule) -> String {
        let mut bytes = vec![];
        m.serialize_with_version(m.version, &mut bytes).unwrap();
        crate::decompile_verified_bytecode(&bytes).unwrap().0
    }
    fn add_void_native(m: &mut ff::CompiledModule) {
        let mut handle = m.function_handles[0].clone();
        handle.name = ff::IdentifierIndex(3); // x
        handle.parameters = ff::SignatureIndex(0);
        handle.return_ = ff::SignatureIndex(0);
        m.function_handles.push(handle);
        m.function_defs.push(ff::FunctionDefinition {
            function: ff::FunctionHandleIndex((m.function_handles.len() - 1) as u16),
            visibility: ff::Visibility::Private,
            is_entry: false,
            acquires_global_resources: vec![],
            code: None,
        });
    }
    #[test]
    fn reconstruction_does_not_delay_arithmetic_past_a_void_call() {
        let mut m = module(
            vec![T::U64, T::U64],
            vec![T::U64],
            vec![],
            vec![I::MoveLoc(0), I::MoveLoc(1), I::Div, I::Ret],
        );
        add_void_native(&mut m);
        m.function_defs[0]
            .code
            .as_mut()
            .unwrap()
            .code
            .insert(3, I::Call(ff::FunctionHandleIndex(1)));
        let source = source(&m);
        assert!(
            source.find(" / ").unwrap() < source.find("::x()").unwrap(),
            "{source}"
        );
    }
    #[test]
    fn reconstruction_does_not_delay_a_call_past_another_call() {
        let mut m = module(vec![], vec![T::U64], vec![], vec![I::LdU64(0), I::Ret]);
        let mut handle = m.function_handles[0].clone();
        handle.name = ff::IdentifierIndex(2); // Bar
        m.function_handles.push(handle);
        m.function_defs.push(ff::FunctionDefinition {
            function: ff::FunctionHandleIndex(1),
            visibility: ff::Visibility::Private,
            is_entry: false,
            acquires_global_resources: vec![],
            code: None,
        });
        add_void_native(&mut m);
        m.function_defs[0].code.as_mut().unwrap().code = vec![
            I::Call(ff::FunctionHandleIndex(1)),
            I::Call(ff::FunctionHandleIndex(2)),
            I::Ret,
        ];
        let source = source(&m);
        assert!(
            source.find("::Bar()").unwrap() < source.find("::x()").unwrap(),
            "{source}"
        );
    }
    #[test]
    fn reconstruction_snapshots_reads_before_writes() {
        let m = module(
            vec![T::MutableReference(Box::new(T::U64))],
            vec![T::U64],
            vec![],
            vec![
                I::CopyLoc(0),
                I::ReadRef,
                I::LdU64(9),
                I::MoveLoc(0),
                I::WriteRef,
                I::Ret,
            ],
        );
        let source = source(&m);
        assert!(
            source.find("= *l0").unwrap() < source.find("= 9u64").unwrap(),
            "{source}"
        );
    }
    #[test]
    fn reconstruction_snapshots_locals_before_reassignment() {
        let m = module(
            vec![T::U64],
            vec![T::U64],
            vec![],
            vec![I::CopyLoc(0), I::LdU64(9), I::StLoc(0), I::Ret],
        );
        let source = source(&m);
        assert!(source.contains("let reg_0 = l0;"), "{source}");
        assert!(source.contains("return reg_0"), "{source}");
    }
    #[test]
    fn pure_pack_can_move_but_its_field_value_cannot_change() {
        let mut a = module(
            vec![],
            vec![T::Datatype(ff::DatatypeHandleIndex(0))],
            vec![],
            vec![I::LdU64(1), I::Pack(ff::StructDefinitionIndex(0)), I::Ret],
        );
        add_void_native(&mut a);
        a.function_defs[0]
            .code
            .as_mut()
            .unwrap()
            .code
            .insert(2, I::Call(ff::FunctionHandleIndex(1)));
        let mut b = a.clone();
        b.function_defs[0].code.as_mut().unwrap().code = vec![
            I::Call(ff::FunctionHandleIndex(1)),
            I::LdU64(1),
            I::Pack(ff::StructDefinitionIndex(0)),
            I::Ret,
        ];
        move_bytecode_verifier::verify_module_unmetered(&a).unwrap();
        move_bytecode_verifier::verify_module_unmetered(&b).unwrap();
        check(a.clone(), b.clone(), true);
        b.function_defs[0].code.as_mut().unwrap().code[1] = I::LdU64(2);
        check(a, b, false);
    }
    #[test]
    fn u256_immediate_and_constant_agree_only_for_the_same_value() {
        let a = module(
            vec![],
            vec![T::U256],
            vec![],
            vec![I::LdU256(Box::new(0u64.into())), I::Ret],
        );
        let mut b = a.clone();
        b.constant_pool.push(ff::Constant {
            type_: T::U256,
            data: vec![0; 32],
        });
        b.function_defs[0].code.as_mut().unwrap().code[0] = I::LdConst(ff::ConstantPoolIndex(0));
        move_bytecode_verifier::verify_module_unmetered(&b).unwrap();
        check(a.clone(), b.clone(), true);
        b.constant_pool[0].data[0] = 1;
        check(a, b, false);
    }
}
