// Copyright (c) The Move Contributors
// SPDX-License-Identifier: Apache-2.0

//! NMG can emit complementary paths as two independent if statements. Recover
//! their exhaustive if/else so Move can prove definite assignment, without
//! initializing bytecode locals to fabricated default values.
use super::{Refine, liveness::{referenced_names, NameCounts}, utils::{peek, peek_mut}};
use crate::ast::Exp;
use move_core_types::runtime_value::MoveValue;
use move_stackless_bytecode_2::ast::PrimitiveOp;
use std::collections::BTreeSet;

fn boolean(e: &Exp, names: &mut BTreeSet<String>) -> bool {
    match peek(e) {
        Exp::Variable(n) => { names.insert(n.clone()); true }
        Exp::Value(MoveValue::Bool(_)) => true,
        Exp::Primitive { op: PrimitiveOp::Not, args } if args.len() == 1 => boolean(&args[0], names),
        Exp::Primitive { op: PrimitiveOp::And | PrimitiveOp::Or, args } if args.len() == 2 =>
            boolean(&args[0], names) && boolean(&args[1], names),
        _ => false,
    }
}
fn eval(e: &Exp, names: &[String], bits: usize) -> bool {
    match peek(e) {
        Exp::Variable(n) => bits & (1 << names.iter().position(|x| x == n).unwrap()) != 0,
        Exp::Value(MoveValue::Bool(b)) => *b,
        Exp::Primitive { op: PrimitiveOp::Not, args } => !eval(&args[0], names, bits),
        Exp::Primitive { op: PrimitiveOp::And, args } => eval(&args[0], names, bits) && eval(&args[1], names, bits),
        Exp::Primitive { op: PrimitiveOp::Or, args } => eval(&args[0], names, bits) || eval(&args[1], names, bits),
        _ => unreachable!("validated pure boolean formula"),
    }
}
fn recover(first: &Exp, second: &Exp, borrowed: &BTreeSet<String>) -> Option<(Exp, Exp)> {
    let Exp::IfElse(outer, nested, no_else) = peek(first) else { return None; };
    let Exp::IfElse(other_guard, other_body, other_else) = peek(second) else { return None; };
    if no_else.is_some() || other_else.is_some() { return None; }
    let (prefix, tail) = match peek(nested) {
        Exp::Seq(es) => (es[..es.len().checked_sub(1)?].to_vec(), es.last()?),
        e => (vec![], e),
    };
    let Exp::IfElse(inner, body, inner_else) = peek(tail) else { return None; };
    if inner_else.is_some() { return None; }
    let mut names = BTreeSet::new();
    if !boolean(outer, &mut names) || !boolean(inner, &mut names) || !boolean(other_guard, &mut names)
        || names.len() > 8 { return None; }
    // An alias may mutate a predicate without mentioning its local name in
    // the payload. Reject predicates mutably borrowed anywhere in the function.
    if !names.is_disjoint(borrowed) { return None; }
    // Moving evaluation across the payload/prefix must not change any predicate.
    if !referenced_names(body).is_disjoint(&names) { return None; }
    let mut outer_names = BTreeSet::new();
    boolean(outer, &mut outer_names);
    let prefix = Exp::Seq(prefix);
    if !referenced_names(&prefix).is_disjoint(&outer_names) { return None; }
    // The inner guard/body leave the prefix's lexical scope. They may read
    // assigned outer locals, but must not capture a let/pattern declared there.
    let bindings = NameCounts::analyze(&prefix);
    let mut moved_names = referenced_names(inner);
    moved_names.extend(referenced_names(body));
    if moved_names.iter().any(|n| bindings.letbinds(n) + bindings.declares(n) + bindings.unpacks(n) > 0) {
        return None;
    }
    let names: Vec<_> = names.into_iter().collect();
    for bits in 0..(1usize << names.len()) {
        if eval(other_guard, &names, bits) == (eval(outer, &names, bits) && eval(inner, &names, bits)) {
            return None;
        }
    }
    Some((
        Exp::IfElse(outer.clone(), Box::new(prefix), Box::new(None)),
        Exp::IfElse(Box::new(Exp::Primitive { op: PrimitiveOp::And, args: vec![*outer.clone(), *inner.clone()] }),
            body.clone(), Box::new(Some(*other_body.clone()))),
    ))
}
struct Recover { borrowed: BTreeSet<String> }
impl Refine for Recover {
    fn refine_custom(&mut self, e: &mut Exp) -> bool {
        let Exp::Seq(es) = peek_mut(e) else { return false; };
        for i in 0..es.len().saturating_sub(1) {
            if let Some((first, second)) = recover(&es[i], &es[i+1], &self.borrowed) {
                es[i] = first; es[i+1] = second;
                return true;
            }
        }
        false
    }
}
pub fn refine(e: &mut Exp) -> bool {
    let counts = NameCounts::analyze(e);
    let borrowed = referenced_names(e).into_iter().filter(|n| counts.mut_borrows(n) > 0).collect();
    Recover { borrowed }.refine(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recover(first: &Exp, second: &Exp) -> Option<(Exp, Exp)> {
        super::recover(first, second, &BTreeSet::new())
    }
    fn var(n: &str) -> Exp { Exp::Variable(n.into()) }
    fn not(e: Exp) -> Exp { Exp::Primitive {op: PrimitiveOp::Not, args:vec![e]} }
    fn assign(n: &str) -> Exp { Exp::Assign(vec![n.into()],Box::new(Exp::Value(MoveValue::Bool(true)))) }
    fn pair() -> (Exp, Exp) {
        let first=Exp::IfElse(Box::new(var("a")),Box::new(Exp::Seq(vec![assign("b"),
            Exp::IfElse(Box::new(var("b")),Box::new(assign("result")),Box::new(None))])),Box::new(None));
        let guard=Exp::Primitive {op:PrimitiveOp::Or,args:vec![not(var("a")),
            Exp::Primitive {op:PrimitiveOp::And,args:vec![var("a"),not(var("b"))]}]};
        (first,Exp::IfElse(Box::new(guard),Box::new(assign("result")),Box::new(None)))
    }
    #[test]
    fn proves_complementary_guards_and_keeps_conditional_prefix() {
        let (a,b)=pair();let (prefix,decision)=recover(&a,&b).unwrap();
        assert!(matches!(prefix,Exp::IfElse(_,_,e) if e.is_none()));
        assert!(matches!(decision,Exp::IfElse(_,_,e) if e.is_some()));
    }
    #[test]
    fn rejects_non_complementary_guard() {
        let (a,mut b)=pair();if let Exp::IfElse(c,_,_)=&mut b {*c=Box::new(var("a"));}
        assert!(recover(&a,&b).is_none());
    }
    #[test]
    fn rejects_payload_that_changes_predicate() {
        let (mut a,b)=pair();if let Exp::IfElse(_,nested,_)=&mut a {
            if let Exp::Seq(es)=nested.as_mut() {if let Exp::IfElse(_,body,_)=&mut es[1] {*body=Box::new(assign("a"));}}
        }
        assert!(recover(&a,&b).is_none());
    }
    #[test]
    fn never_moves_a_use_outside_its_prefix_binding_scope() {
        let (mut a,b)=pair();
        if let Exp::IfElse(_,nested,_)=&mut a {
            if let Exp::Seq(es)=nested.as_mut() {
                es.insert(0,Exp::LetBind(vec!["local".into()],Box::new(Exp::Value(MoveValue::Bool(true)))));
                if let Exp::IfElse(_,body,_)=&mut es[2] {
                    *body=Box::new(Exp::Assign(vec!["result".into()],Box::new(var("local"))));
                }
            }
        }
        assert!(recover(&a,&b).is_none());
    }
    #[test]
    fn rejects_predicates_that_can_change_through_an_alias() {
        let (a,b)=pair();
        let mut expression=Exp::Seq(vec![
            Exp::LetBind(vec!["alias".into()],Box::new(Exp::Borrow(true,Box::new(var("a"))))),a,b]);
        assert!(!refine(&mut expression));
    }
}
