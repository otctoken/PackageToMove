// Copyright (c) The Move Contributors
// SPDX-License-Identifier: Apache-2.0

//! Lower transfers to enclosing loops without dropping their targets. The local
//! dispatch tag has no contract-visible effects. Only transfers that actually
//! escape a child loop generate a dispatch at that loop's exit.
use crate::ast::{Exp, Label};
use move_core_types::runtime_value::MoveValue;
use move_stackless_bytecode_2::ast::PrimitiveOp;
use std::collections::BTreeSet;

type Transfer = (usize, bool); // enclosing loop depth, continue rather than break
const TAG: &str = "__legacy_loop_transfer";

pub fn lower(code: &Exp) -> Option<Exp> {
    // Never capture a pre-existing local, even for callers constructing ASTs.
    if format!("{code:?}").contains(TAG) { return None; }
    let mut code = code.clone();
    let mut used = false;
    let escaped = visit(&mut code, &mut vec![], &mut used)?;
    if !escaped.is_empty() { return None; }
    if used {
        code = Exp::Seq(vec![Exp::LetBind(vec![TAG.into()], Box::new(value(0))), code]);
    }
    Some(code)
}

fn value(n: u64) -> Exp { Exp::Value(MoveValue::U64(n)) }
fn tag(t: Transfer) -> u64 { 1 + 2 * t.0 as u64 + u64::from(t.1) }
fn set(n: u64) -> Exp { Exp::Assign(vec![TAG.into()], Box::new(value(n))) }
fn jump(cont: bool) -> Exp { if cont { Exp::Continue(None) } else { Exp::Break(None) } }

fn visit(e: &mut Exp, loops: &mut Vec<Option<Label>>, used: &mut bool) -> Option<BTreeSet<Transfer>> {
    let mut escaped = BTreeSet::new();
    match e {
        Exp::Break(_) | Exp::Continue(_) => {
            let cont = matches!(e, Exp::Continue(_));
            let label = match e { Exp::Break(l) | Exp::Continue(l) => *l, _ => unreachable!() };
            let depth = match label {
                Some(l) => loops.iter().rposition(|v| *v == Some(l))?,
                None => loops.len().checked_sub(1)?,
            };
            if depth + 1 == loops.len() { *e = jump(cont); }
            else {
                let transfer = (depth, cont);
                *used = true;
                *e = Exp::Seq(vec![set(tag(transfer)), Exp::Break(None)]);
                escaped.insert(transfer);
            }
        }
        Exp::Loop(_, _) | Exp::While(_, _, _) => {
            let label = match e { Exp::Loop(l, _) | Exp::While(l, _, _) => *l, _ => unreachable!() };
            loops.push(label);
            let child_escaped = match e {
                Exp::Loop(l, body) => { *l = None; visit(body, loops, used)? }
                Exp::While(l, cond, body) => {
                    *l = None;
                    // Conditions are expressions, never a place for a loop transfer.
                    if !visit(cond, loops, used)?.is_empty() { return None; }
                    visit(body, loops, used)?
                }
                _ => unreachable!(),
            };
            loops.pop();
            if !child_escaped.is_empty() {
                let original = std::mem::replace(e, Exp::Seq(vec![]));
                let mut sequence = vec![original];
                for transfer in child_escaped {
                    let consumes = transfer.0 + 1 == loops.len();
                    let action = if consumes {
                        Exp::Seq(vec![set(0), jump(transfer.1)])
                    } else {
                        escaped.insert(transfer);
                        Exp::Break(None)
                    };
                    sequence.push(Exp::IfElse(Box::new(Exp::Primitive {
                        op: PrimitiveOp::Equal,
                        args: vec![Exp::Variable(TAG.into()), value(tag(transfer))],
                    }), Box::new(action), Box::new(None)));
                }
                *e = Exp::Seq(sequence);
            }
        }
        Exp::Seq(es) | Exp::Return(es) | Exp::Call(_, es)
        | Exp::Primitive { args: es, .. } | Exp::Data { args: es, .. } => {
            for child in es { escaped.extend(visit(child, loops, used)?); }
        }
        Exp::IfElse(c, a, b) => {
            escaped.extend(visit(c, loops, used)?);
            escaped.extend(visit(a, loops, used)?);
            if let Some(b) = b.as_mut() { escaped.extend(visit(b, loops, used)?); }
        }
        Exp::Block(_, x) | Exp::Assign(_, x) | Exp::LetBind(_, x) | Exp::Abort(x)
        | Exp::Borrow(_, x) | Exp::Unpack(_, _, x) | Exp::VecUnpack(_, x) => {
            escaped.extend(visit(x, loops, used)?);
        }
        Exp::Switch(..) | Exp::Match(..) | Exp::MatchLit(..) | Exp::UnpackVariant(..)
        | Exp::Unstructured(..) => return None,
        Exp::Declare(_) | Exp::Value(_) | Exp::Variable(_) | Exp::Constant(_) => (),
    }
    Some(escaped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Debug, PartialEq)]
    enum Flow { Next, Jump(Option<Label>, bool) }
    fn var(s: &str) -> Exp { Exp::Variable(s.into()) }
    fn op(op: PrimitiveOp, a: Exp, b: Exp) -> Exp { Exp::Primitive { op, args: vec![a,b] } }
    fn assign(s: &str, e: Exp) -> Exp { Exp::Assign(vec![s.into()], Box::new(e)) }
    fn seq(es: Vec<Exp>) -> Exp { Exp::Seq(es) }
    fn emit(n: u64) -> Exp { assign("event", value(n)) }
    fn expr(e: &Exp, locals: &BTreeMap<String,u64>) -> u64 {
        match e {
            Exp::Value(MoveValue::U64(n)) => *n,
            Exp::Variable(s) => locals[s],
            Exp::Primitive { op, args } => {
                let a=expr(&args[0],locals); let b=expr(&args[1],locals);
                match op { PrimitiveOp::Add => a+b, PrimitiveOp::Equal => u64::from(a==b),
                    PrimitiveOp::LessThan => u64::from(a<b), _ => panic!("unsupported expression") }
            }
            _ => panic!("unsupported expression"),
        }
    }
    fn run(e: &Exp, locals: &mut BTreeMap<String,u64>, trace: &mut Vec<u64>, fuel: &mut usize) -> Flow {
        *fuel=fuel.checked_sub(1).expect("non-terminating lowering");
        match e {
            Exp::Seq(es) => for e in es { let f=run(e,locals,trace,fuel); if f!=Flow::Next { return f; } },
            Exp::LetBind(names,x) | Exp::Assign(names,x) => {
                let n=expr(x,locals); locals.insert(names[0].clone(),n);
                if names[0]=="event" { trace.push(n); }
            }
            Exp::IfElse(c,a,b) => {
                if expr(c,locals)!=0 { return run(a,locals,trace,fuel); }
                if let Some(b)=b.as_ref() { return run(b,locals,trace,fuel); }
            }
            Exp::Loop(label, body) | Exp::While(label, _, body) => loop {
                if let Exp::While(_,cond,_)=e { if expr(cond,locals)==0 { break; } }
                match run(body,locals,trace,fuel) {
                    Flow::Next => (),
                    Flow::Jump(target,cont) if target.is_none() || target==*label => {
                        if !cont { break; }
                    }
                    transfer => return transfer,
                }
            },
            Exp::Break(l) => return Flow::Jump(*l,false),
            Exp::Continue(l) => return Flow::Jump(*l,true),
            _ => panic!("unsupported statement"),
        }
        Flow::Next
    }
    fn counted(label: Label, name: &str, body: Exp) -> Exp {
        seq(vec![assign(name,value(0)), Exp::While(Some(label),
            Box::new(op(PrimitiveOp::LessThan,var(name),value(3))),
            Box::new(seq(vec![assign(name,op(PrimitiveOp::Add,var(name),value(1))),body])))])
    }
    #[test]
    fn nested_transfers_preserve_iteration_counts_and_observable_order() {
        for target in [None,Some(10),Some(20),Some(30)] {
            for cont in [false,true] {
                let transfer=if cont { Exp::Continue(target) } else { Exp::Break(target) };
                let code=seq(vec![counted(10,"i",seq(vec![
                    counted(20,"j",seq(vec![
                        counted(30,"k",seq(vec![Exp::IfElse(
                            Box::new(op(PrimitiveOp::Equal,var("k"),value(2))),
                            Box::new(transfer),Box::new(None)),emit(1)])),emit(2)])),emit(3)])),emit(4)]);
                let lowered=lower(&code).unwrap();
                let (mut a,mut b)=(BTreeMap::new(),BTreeMap::new());
                let (mut ta,mut tb)=(vec![],vec![]);
                assert_eq!(run(&code,&mut a,&mut ta,&mut 10000),Flow::Next);
                assert_eq!(run(&lowered,&mut b,&mut tb,&mut 10000),Flow::Next);
                b.remove(TAG);
                assert_eq!(a,b,"target={target:?}, continue={cont}");
                assert_eq!(ta,tb,"target={target:?}, continue={cont}");
            }
        }
    }
    #[test]
    fn unresolved_targets_and_captured_locals_are_rejected() {
        assert!(lower(&Exp::Break(Some(99))).is_none());
        assert!(lower(&assign(TAG,value(0))).is_none());
    }
}
