// Copyright (c) The Move Contributors
// SPDX-License-Identifier: Apache-2.0

//! Inline a single-use binding at the next eager evaluation position.
//!
//! For an `Seq([..., LetBind([X], e), next, ...])` we fire when:
//!   - `X` has exactly one defining `LetBind` (this one), zero `Assign`/`Declare`/`Unpack`,
//!     and exactly one `Variable` read across the whole function.
//!   - The unique read sits at `next`'s *head position* - the first child evaluated when
//!     `next` runs. We walk `next` down its leftmost evaluation chain (`Return([head])`,
//!     `Call(_, [head, ..])`, `IfElse(head, _, _)`, etc.) and require to arrive at
//!     `Variable(X)`. Typed scalar and immutable-reference slot reads may precede it
//!     only if the delayed RHS cannot write those slots. Resource moves, exclusive
//!     references, mutable-borrowed slots and short-circuit RHS positions are excluded.
//!
//! When both hold, the binding is removed and the `Variable(X)` slot in `next` is replaced
//! with `e`. Head-position is the safety net: `e` evaluates exactly where the original
//! `let X = e` had it execute (first), so any side effects in `e` happen at the same point.
//!
//! Complements `inline_immutable_alias` (which only handles `let X = Y;` where the RHS is a
//! variable). Here `e` can be any expression - `f(...)`, a struct unpack, a literal, etc.
//! The decompiler emits many `let regN = expr; ...next...` shapes that this collapses.

use crate::{
    ast::Exp,
    refinement::{Refine, liveness::NameCounts},
};
use move_stackless_bytecode_2::ast::DataOp;
use std::collections::HashSet;

struct InlineContext<'a> {
    counts: &'a NameCounts,
    scalars: &'a HashSet<String>,
}
impl std::ops::Deref for InlineContext<'_> {
    type Target = NameCounts;
    fn deref(&self) -> &NameCounts {
        self.counts
    }
}

pub fn refine(exp: &mut Exp, scalars: &HashSet<String>) -> bool {
    let counts = NameCounts::analyze(exp);
    CollapseLetUsage {
        counts: &InlineContext {
            counts: &counts,
            scalars,
        },
    }
    .refine(exp)
}

struct CollapseLetUsage<'a> {
    counts: &'a InlineContext<'a>,
}

impl Refine for CollapseLetUsage<'_> {
    fn refine_custom(&mut self, exp: &mut Exp) -> bool {
        let Exp::Seq(items) = exp else {
            return false;
        };
        collapse_in_seq(items, self.counts)
    }
}

// ------------------------------------------------------------------------------------------------
// Per-Seq collapse loop

fn collapse_in_seq(items: &mut Vec<Exp>, counts: &InlineContext<'_>) -> bool {
    let mut changed = false;
    let mut i = 0;
    while i + 1 < items.len() {
        let Exp::LetBind(targets, rhs) = &items[i] else {
            i += 1;
            continue;
        };
        if targets.len() != 1 {
            i += 1;
            continue;
        }
        let x = targets[0].clone();
        if !is_eligible(&x, counts) {
            i += 1;
            continue;
        }
        let rhs_counts = NameCounts::analyze(rhs);
        let stable_scalars: HashSet<_> = counts
            .scalars
            .iter()
            .filter(|n| rhs_counts.assigns(n) == 0)
            .cloned()
            .collect();
        let site = InlineContext {
            counts: counts.counts,
            scalars: &stable_scalars,
        };
        if !head_var_is(&items[i + 1], &x, &site) {
            i += 1;
            continue;
        }

        // Commit: pull the binding out and substitute its RHS into the next item's head slot.
        let Exp::LetBind(_, rhs) = items.remove(i) else {
            unreachable!()
        };
        let mut payload = Some(*rhs);
        let replaced = replace_head_var(&mut items[i], &x, &mut payload, &site);
        debug_assert!(
            replaced,
            "head_var_is returned true but replace_head_var did not"
        );
        changed = true;
        // Don't advance `i` - the new items[i] might itself be a candidate for further
        // collapsing on the next iteration of this loop.
    }
    changed
}

// ------------------------------------------------------------------------------------------------
// Eligibility

fn is_eligible(x: &str, counts: &InlineContext<'_>) -> bool {
    counts.reads(x) == 1
        && counts.letbinds(x) == 1
        && counts.assigns(x) == 0
        && counts.declares(x) == 0
        && counts.unpacks(x) == 0
}

// ------------------------------------------------------------------------------------------------
// Head-position navigation

/// Walk `exp` down its leftmost-evaluated child chain and return `true` if we land on
/// `Variable(name)`. This is the read-side mirror of `replace_head_var`.
fn inert(exp: &Exp, counts: &InlineContext<'_>) -> bool {
    match exp {
        Exp::Value(_) | Exp::Constant(_) => true,
        // Moving a stable slot read before the inlined expression cannot change
        // its value. The site excludes writes in the delayed expression; a
        // borrow of the slot anywhere rules out indirect writes through aliases.
        Exp::Variable(n) => counts.scalars.contains(n) && counts.mut_borrows(n) == 0,
        _ => false,
    }
}
fn argument_index(exp: &Exp, name: &str, counts: &InlineContext<'_>) -> Option<usize> {
    let args = match exp {
        // Move &&/|| short-circuit. Moving a preceding evaluation into their
        // second operand could skip a call/abort that originally always ran.
        Exp::Primitive {
            op:
                move_stackless_bytecode_2::ast::PrimitiveOp::And
                | move_stackless_bytecode_2::ast::PrimitiveOp::Or,
            ..
        } => return None,
        Exp::Call(_, args) | Exp::Return(args) | Exp::Primitive { args, .. } => args,
        Exp::Data {
            op: DataOp::WriteRef,
            ..
        } => return None,
        Exp::Data { args, .. } => args,
        _ => return None,
    };
    for (i, arg) in args.iter().enumerate() {
        if head_var_is(arg, name, counts) {
            return Some(i);
        }
        if !inert(arg, counts) {
            break;
        }
    }
    None
}

#[cfg(test)]
mod order_tests {
    use super::*;
    use move_stackless_bytecode_2::ast::PrimitiveOp;
    fn var(n: &str) -> Exp {
        Exp::Variable(n.into())
    }
    fn fixture(tail: Exp) -> Exp {
        Exp::Seq(vec![
            Exp::LetBind(
                vec!["temporary".into()],
                Box::new(Exp::Data {
                    op: DataOp::ReadRef,
                    args: vec![var("reference")],
                }),
            ),
            tail,
        ])
    }
    #[test]
    fn skips_stable_scalar_but_never_resource_or_exclusive_reference() {
        let mut scalar = fixture(Exp::Return(vec![var("first"), var("temporary")]));
        assert!(refine(&mut scalar, &HashSet::from(["first".into()])));
        let mut resource = fixture(Exp::Return(vec![var("first"), var("temporary")]));
        assert!(!refine(&mut resource, &HashSet::new()));
    }
    #[test]
    fn cannot_delay_an_eager_read_into_short_circuit_rhs() {
        for op in [PrimitiveOp::And, PrimitiveOp::Or] {
            let mut code = fixture(Exp::Return(vec![Exp::Primitive {
                op,
                args: vec![var("first"), var("temporary")],
            }]));
            assert!(!refine(&mut code, &HashSet::from(["first".into()])));
        }
    }
}
fn head_var_is(exp: &Exp, name: &str, counts: &InlineContext<'_>) -> bool {
    if argument_index(exp, name, counts).is_some() {
        return true;
    }
    match exp {
        Exp::Variable(n) => n == name,
        _ => head_ref(exp).is_some_and(|h| head_var_is(h, name, counts)),
    }
}

/// Walk `exp` down its leftmost-evaluated child chain and replace the `Variable(name)` leaf
/// with the contents of `replacement` (consumed). Returns `true` iff the leaf was found.
fn replace_head_var(
    exp: &mut Exp,
    name: &str,
    replacement: &mut Option<Exp>,
    counts: &InlineContext<'_>,
) -> bool {
    if let Exp::Variable(n) = exp {
        if n == name {
            *exp = replacement.take().expect("replacement available");
            return true;
        }
        return false;
    }
    if let Some(i) = argument_index(exp, name, counts) {
        let args = match exp {
            Exp::Call(_, args)
            | Exp::Return(args)
            | Exp::Primitive { args, .. }
            | Exp::Data { args, .. } => args,
            _ => unreachable!(),
        };
        return replace_head_var(&mut args[i], name, replacement, counts);
    }
    head_mut(exp).is_some_and(|h| replace_head_var(h, name, replacement, counts))
}

/// The child of `exp` evaluated first under Move semantics, or `None` if `exp` either has no
/// children or evaluates them in an order we can't safely substitute through (control flow,
/// `Seq` between us and a clean head, `Unstructured`).
fn head_ref(exp: &Exp) -> Option<&Exp> {
    match exp {
        // Single-child wrappers: head of `e` is what flows in first.
        Exp::Abort(e)
        | Exp::Borrow(_, e)
        | Exp::VecUnpack(_, e)
        | Exp::Unpack(_, _, e)
        | Exp::UnpackVariant(_, _, _, e)
        | Exp::Block(_, e) => Some(e),
        Exp::LetBind(_, rhs) | Exp::Assign(_, rhs) => Some(rhs),
        // Multi-arg constructs: leftmost arg.
        Exp::Return(items) | Exp::Call(_, items) => items.first(),
        // AST WriteRef stores [reference, value], but Move evaluates the RHS
        // value BEFORE the assignment target. Inlining into reference here can
        // move a dynamic-field borrow past an effectful/aborting RHS call.
        Exp::Data {
            op: DataOp::WriteRef,
            args,
        } => args.get(1),
        Exp::Primitive { args, .. } | Exp::Data { args, .. } => args.first(),
        // Control flow: the condition / subject is what's evaluated first.
        Exp::IfElse(cond, _, _) => Some(cond),
        Exp::Switch(subj, _, _) => Some(subj),
        Exp::Match(subj, _, _) => Some(subj),
        Exp::MatchLit(subj, _) => Some(subj),
        // No safe head to substitute through:
        //   - Loop/While bodies execute repeatedly; substituting in would change frequency.
        //   - Seq has multiple items; the head idea doesn't compose cleanly here (a `Seq`
        //     immediately after the LetBind would mean substituting deep into an inner
        //     block past intermediate statements).
        //   - Leaves have no child.
        //   - Unstructured is opaque control flow.
        Exp::Loop(_, _)
        | Exp::While(_, _, _)
        | Exp::Seq(_)
        | Exp::Declare(_)
        | Exp::Value(_)
        | Exp::Variable(_)
        | Exp::Constant(_)
        | Exp::Break(_)
        | Exp::Continue(_)
        | Exp::Unstructured(_) => None,
    }
}

fn head_mut(exp: &mut Exp) -> Option<&mut Exp> {
    match exp {
        Exp::Abort(e)
        | Exp::Borrow(_, e)
        | Exp::VecUnpack(_, e)
        | Exp::Unpack(_, _, e)
        | Exp::UnpackVariant(_, _, _, e)
        | Exp::Block(_, e) => Some(e),
        Exp::LetBind(_, rhs) | Exp::Assign(_, rhs) => Some(rhs),
        Exp::Return(items) | Exp::Call(_, items) => items.first_mut(),
        Exp::Data {
            op: DataOp::WriteRef,
            args,
        } => args.get_mut(1),
        Exp::Primitive { args, .. } | Exp::Data { args, .. } => args.first_mut(),
        Exp::IfElse(cond, _, _) => Some(cond),
        Exp::Switch(subj, _, _) => Some(subj),
        Exp::Match(subj, _, _) => Some(subj),
        Exp::MatchLit(subj, _) => Some(subj),
        Exp::Loop(_, _)
        | Exp::While(_, _, _)
        | Exp::Seq(_)
        | Exp::Declare(_)
        | Exp::Value(_)
        | Exp::Variable(_)
        | Exp::Constant(_)
        | Exp::Break(_)
        | Exp::Continue(_)
        | Exp::Unstructured(_) => None,
    }
}
