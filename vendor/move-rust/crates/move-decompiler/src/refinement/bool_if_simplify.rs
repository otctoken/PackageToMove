// Copyright (c) The Move Contributors
// SPDX-License-Identifier: Apache-2.0

//! Collapse mixed boolean-literal/expression arms into short-circuited `&&`/`||`.
//!
//! For a conditional whose conseq and/or alt is a literal `true`/`false`:
//!
//! | conseq | alt  | output    |
//! |--------|------|-----------|
//! | `true` | `e`     | `t \|\| e`  |
//! | `false`| `e`     | `!t && e` |
//! | `e`    | `true`  | `!t \|\| e` |
//! | `e`    | `false` | `t && e`  |
//!
//! Both-literal conditionals retain their original branch and selected value.
//!
//! The mixed forms map to short-circuited `&&`/`||`,
//! which evaluate `t` then conditionally evaluate `e` - the same observable behavior as the
//! original if's arm selection.
//!
//! We peek through any `Block` wrapper on an arm (it carries a block ID for goto cross-
//! referencing, irrelevant to the pattern). We do *not* peek through a `Seq` with leading
//! statements: rewriting `Seq([side_effect, true])` to `t || side_effect_then_true` would
//! short-circuit away the side effect when `t` is `true`.

use move_core_types::runtime_value::MoveValue as Value;
use move_stackless_bytecode_2::ast::PrimitiveOp;

use crate::{
    ast::Exp,
    refinement::{Refine, utils},
};

pub fn refine(exp: &mut Exp) -> bool {
    BoolIfSimplify.refine(exp)
}

struct BoolIfSimplify;

impl Refine for BoolIfSimplify {
    fn refine_custom(&mut self, exp: &mut Exp) -> bool {
        let Exp::IfElse(cond, conseq, alt) = exp else {
            return false;
        };
        let Some(alt) = alt.as_ref().as_ref() else {
            return false;
        };

        let conseq_bool = bool_literal(conseq);
        let alt_bool = bool_literal(alt);

        let new_exp = match (conseq_bool, alt_bool) {
            // Keep the bytecode's branch/value selection instead of relying on
            // predicate-equivalence normalization in the audit comparator.
            (Some(_), Some(_)) => return false,
            (Some(true), None) => or(take_cond(cond), alt.clone()),
            (Some(false), None) => and(negated(take_cond(cond)), alt.clone()),
            (None, Some(true)) => or(negated(take_cond(cond)), (**conseq).clone()),
            (None, Some(false)) => and(take_cond(cond), (**conseq).clone()),
            _ => return false,
        };
        *exp = new_exp;
        true
    }
}

// ------------------------------------------------------------------------------------------------
// Helpers

/// `Some(b)` iff `exp` is a bare boolean literal, possibly wrapped in `Block`.
fn bool_literal(exp: &Exp) -> Option<bool> {
    match utils::peek(exp) {
        Exp::Value(Value::Bool(b)) => Some(*b),
        _ => None,
    }
}

/// Move the condition out of the `IfElse` we're rewriting. The caller has already verified
/// it's the right shape; replace the slot with a placeholder so we can take ownership.
fn take_cond(cond: &mut Box<Exp>) -> Exp {
    std::mem::replace(cond.as_mut(), Exp::Value(Value::Bool(false)))
}

fn negated(mut e: Exp) -> Exp {
    utils::negate(&mut e);
    e
}

fn or(a: Exp, b: Exp) -> Exp {
    Exp::Primitive {
        op: PrimitiveOp::Or,
        args: vec![a, b],
    }
}

fn and(a: Exp, b: Exp) -> Exp {
    Exp::Primitive {
        op: PrimitiveOp::And,
        args: vec![a, b],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_arms_keep_the_original_branch_and_values() {
        for (a,b) in [(true,false),(false,true),(true,true),(false,false)] {
            let mut code=Exp::IfElse(Box::new(Exp::Variable("condition".into())),
                Box::new(Exp::Value(Value::Bool(a))),Box::new(Some(Exp::Value(Value::Bool(b)))));
            let before=format!("{code:?}");
            assert!(!refine(&mut code));
            assert_eq!(format!("{code:?}"),before);
        }
    }
}
