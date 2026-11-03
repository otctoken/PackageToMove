// Copyright (c) The Move Contributors
// SPDX-License-Identifier: Apache-2.0

//! Recover a single source match from tag inspection followed by repeated
//! reference/value unpacks. Move permits variant destructuring only in patterns.
//! Only handle straight-line arms whose enum aliases are otherwise unused. Do
//! not invent wildcard aborts or erase reads/writes to make a program compile.
use super::{Refine, liveness::referenced_names, utils::{peek, peek_mut}};
use crate::ast::{Exp, UnpackKind};
use move_stackless_bytecode_2::ast::DataOp;
use std::collections::{BTreeMap, BTreeSet};

type Aliases = BTreeMap<String, String>;
fn identity(e: &Exp, aliases: &Aliases) -> Option<String> {
    match peek(e) {
        Exp::Variable(n) => Some(aliases.get(n).unwrap_or(n).clone()),
        Exp::Borrow(_, e) => identity(e, aliases),
        Exp::Data { op: DataOp::FreezeRef, args } if args.len() == 1 => identity(&args[0], aliases),
        _ => None,
    }
}
fn rank(k: &UnpackKind) -> u8 {
    match k { UnpackKind::ImmRef => 0, UnpackKind::MutRef => 1, UnpackKind::Value => 2 }
}
fn statements(e: &Exp) -> Vec<Exp> {
    match peek(e) {
        Exp::Seq(es) => es.iter().flat_map(statements).collect(),
        e => vec![e.clone()],
    }
}
fn discarded(e: &Exp) -> Option<&Exp> {
    match peek(e) {
        Exp::LetBind(ns, rhs) if ns.is_empty() || ns.iter().all(|n| n == "_") => Some(rhs),
        _ => None,
    }
}
fn recover(e: &mut Exp, aliases: &Aliases) -> bool {
    let e = peek_mut(e);
    if let Exp::Return(es) = e {
        return es.len() == 1 && recover(&mut es[0], aliases);
    }
    let Exp::Switch(subject, ty, arms) = e else { return false; };
    let Some(root) = identity(subject, aliases) else { return false; };
    let bodies: Vec<_> = arms.iter().map(|(_, b)| statements(b)).collect();
    let mut selected: Option<(u8, Exp)> = None;
    for ((variant, _), body) in arms.iter().zip(&bodies) {
        for stmt in body {
            if let Exp::UnpackVariant(kind, (enum_ty, v), _, operand) = stmt {
                if enum_ty.to_string() != ty.to_string() || v != variant || identity(operand, aliases) != Some(root.clone()) {
                    return false;
                }
                if selected.as_ref().is_none_or(|(r, _)| rank(kind) > *r) {
                    selected = Some((rank(kind), *operand.clone()));
                }
            } else if let Some(rhs) = discarded(stmt) {
                if identity(rhs, aliases) == Some(root.clone()) { continue; }
                if referenced_names(stmt).iter().any(|n| aliases.get(n).unwrap_or(n) == &root) { return false; }
            } else if referenced_names(stmt).iter().any(|n| aliases.get(n).unwrap_or(n) == &root) {
                return false;
            }
        }
    }
    let Some((mode, operand)) = selected else { return false; };
    let mut new_arms = vec![];
    for ((variant, _), body) in arms.iter().zip(&bodies) {
        let best = body.iter().filter_map(|s| match s {
            Exp::UnpackVariant(k, _, fs, _) => Some((rank(k), fs)), _ => None,
        }).max_by_key(|(r, _)| *r);
        let pattern = best.map(|(_, fs)| fs.clone()).unwrap_or_default();
        let mut dead = BTreeSet::new();
        let mut rewritten = vec![];
        let mut value_unpacks = 0;
        for stmt in body {
            if let Exp::UnpackVariant(k, _, fs, _) = stmt {
                value_unpacks += usize::from(*k == UnpackKind::Value);
                if value_unpacks > 1 { return false; }
                for (field, name) in fs {
                    let used = body.iter().any(|other| {
                        !matches!(other, Exp::UnpackVariant(..))
                            && !discarded(other).is_some_and(|rhs| matches!(peek(rhs), Exp::Variable(n) if n == name))
                            && referenced_names(other).contains(name)
                    });
                    if !used { dead.insert(name.clone()); continue; }
                    // A stronger pattern would change the type of a used binding.
                    // Leave these harder cases untouched instead of adding freezes.
                    if rank(k) != mode { return false; }
                    let Some((_, binding)) = pattern.iter().find(|(f, _)| f == field) else { return false; };
                    if binding != name {
                        rewritten.push(Exp::LetBind(vec![name.clone()], Box::new(Exp::Variable(binding.clone()))));
                    }
                }
            } else { rewritten.push(stmt.clone()); }
        }
        rewritten.retain(|s| {
            let Some(rhs) = discarded(s) else { return true; };
            identity(rhs, aliases) != Some(root.clone())
                && !matches!(peek(rhs), Exp::Variable(n) if dead.contains(n))
        });
        new_arms.push((*variant, pattern, Exp::Seq(rewritten)));
    }
    *e = Exp::Match(Box::new(operand), ty.clone(), new_arms);
    true
}

struct Recover;
impl Refine for Recover {
    fn refine_custom(&mut self, e: &mut Exp) -> bool {
        let Exp::Seq(es) = e else { return false; };
        let mut aliases = Aliases::new();
        for stmt in es {
            if recover(stmt, &aliases) { return true; }
            match peek(stmt) {
                Exp::LetBind(ns, rhs) if ns.len() == 1 => {
                    let name = ns[0].clone();
                    let root = identity(rhs, &aliases);
                    if aliases.contains_key(&name) || aliases.values().any(|r| r == &name) { aliases.clear(); }
                    if let Some(root) = root { aliases.insert(name, root); }
                    else { aliases.remove(&name); }
                }
                // Do not carry aliases across writes or other control flow.
                _ => aliases.clear(),
            }
        }
        false
    }
}
pub fn refine(e: &mut Exp) -> bool { Recover.refine(e) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::TypeRef;
    use move_symbol_pool::Symbol;
    fn var(n: &str) -> Exp { Exp::Variable(n.into()) }
    fn unpack(kind: UnpackKind, operand: Exp, binding: &str) -> Exp {
        Exp::UnpackVariant(kind, (TypeRef::Aliased(Symbol::from("E")), Symbol::from("Some")),
            vec![(Symbol::from("value"), binding.into())], Box::new(operand))
    }
    fn fixture(other_operand: &str, use_borrow: bool) -> Exp {
        let mut arm = vec![unpack(UnpackKind::ImmRef, var("tag"), "borrowed")];
        arm.push(if use_borrow { Exp::LetBind(vec!["saved".into()], Box::new(var("borrowed"))) }
            else { Exp::LetBind(vec![], Box::new(var("borrowed"))) });
        arm.push(unpack(UnpackKind::Value, var(other_operand), "owned"));
        arm.push(Exp::Return(vec![var("owned")]));
        Exp::Seq(vec![
            Exp::LetBind(vec!["tag".into()], Box::new(Exp::Borrow(false, Box::new(var("v"))))),
            Exp::Switch(Box::new(var("tag")), TypeRef::Aliased(Symbol::from("E")),
                vec![(Symbol::from("Some"), Exp::Seq(arm))]),
        ])
    }
    #[test]
    fn borrowed_tag_and_owned_unpack_become_one_match_without_new_abort() {
        let mut e = fixture("v", false);
        assert!(refine(&mut e));
        let Exp::Seq(es) = e else { panic!() };
        let Exp::Match(subject, _, arms) = &es[1] else { panic!() };
        assert!(matches!(subject.as_ref(), Exp::Variable(n) if n == "v"));
        assert_eq!(arms[0].1[0].1, "owned");
        let Exp::Seq(body) = &arms[0].2 else { panic!() };
        assert_eq!(body.len(), 1);
        assert!(matches!(body[0], Exp::Return(_)));
    }
    #[test]
    fn never_lift_an_unpack_of_a_different_enum_value() {
        let mut e = fixture("other", false);
        assert!(!refine(&mut e));
    }
    #[test]
    fn never_change_the_type_of_a_used_reference_binding() {
        let mut e = fixture("v", true);
        assert!(!refine(&mut e));
    }
    #[test]
    fn never_consume_the_enum_when_an_arm_still_uses_it() {
        let mut e = fixture("v", false);
        let Exp::Seq(es) = &mut e else { panic!() };
        let Exp::Switch(_, _, arms) = &mut es[1] else { panic!() };
        let Exp::Seq(body) = &mut arms[0].1 else { panic!() };
        body.push(Exp::Return(vec![var("v")]));
        assert!(!refine(&mut e));
    }
}
