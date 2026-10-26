// Copyright (c) The Move Contributors
// SPDX-License-Identifier: Apache-2.0

//! Acyclic-region structuring (NMG IV-B).
//!
//! [`structure_region`] is the single public entry point. The driver:
//!
//!   1. Compute reaching conditions over the region's acyclic projection (delegated to
//!      `region.rs`).
//!   2. Lay each node out in topological order, guarded by its reaching formula.
//!   3. Run [`recover_control_flow`]'s three-phase recovery (implication nesting,
//!      condition-based factoring, terminator-implication propagation) to rebuild
//!      nested control flow.
//!   4. Recover `Variants -> Switch` patterns (a Move `match` shows up at this stage as
//!      a `Block(N)` followed by per-arm `match-atom`-guarded `CondIf`s).
//!
//! Callers pick a [`region::SinkRendering`] at projection time to control how synthetic
//! sinks (back-edges to `entry`, edges leaving the region's interior) lower:
//!   - `Loop`: sinks become `exit_jump`s, which `insert_breaks` rewrites to
//!     `Break`/`Continue`.
//!   - `Function`: sinks emit empty `Seq([])`. Most of the time they don't fire
//!     (whole-function regions don't have back-edges or out-of-region edges since the
//!     region IS the function), but `Reduced` markers can carry succs that duplicate
//!     jumps already structured inside the marker's body - silencing the synthetic sink
//!     keeps those from leaking out as residual gotos.
//!
//! The decision is recorded once per sink on the `AcyclicProjection`; the AST emitter
//! reads it from there and doesn't need to know which kind of region it's in.

use crate::structuring::{
    ast::{self as D},
    predicates::{self, Formula},
    region::{self, AcyclicProjection, SinkRendering},
};
use move_symbol_pool::Symbol;
use petgraph::graph::NodeIndex;
use std::collections::{BTreeMap, BTreeSet, HashSet};

// =================================================================================================
// Public entry point
// =================================================================================================

/// Structure an acyclic region. `members` defines the region's interior; `entry` may be
/// outside `members` (the loop-body case: head is excluded so back-edges to it fire the
/// out-of-region rule). `rendering` picks how synthetic sinks lower (see the module-level
/// doc). `unstructured` tracks block codes that haven't been emitted yet; every time we
/// commit a `Block(code)` for a real (non-sink) projection node we remove its code so the
/// caller can report any leftover at the top of `structure()`. Returns `None` only when
/// reaching conditions or topological order can't be computed - the caller treats that
/// as a structuring bug.
pub fn structure_region(
    structured_blocks: &BTreeMap<NodeIndex, D::Structured>,
    input: &BTreeMap<NodeIndex, D::Input>,
    entry: NodeIndex,
    members: &HashSet<NodeIndex>,
    rendering: SinkRendering,
    unstructured: &mut HashSet<u64>,
) -> Option<D::Structured> {
    let proj = region::build_acyclic_projection(input, entry, members, rendering);
    // Prefer lexical branch/join nesting when the DAG admits it. Reaching
    // formulas are a fallback for shared-entry shapes, not a reason to hoist
    // branch-local condition values and read them on paths that never set them.
    if let Some((body, remaining)) =
        structure_lexical_dag(&proj, structured_blocks, entry, unstructured)
    {
        *unstructured = remaining;
        return Some(body);
    }
    let reach = region::reaching_conditions(&proj.input, entry)?;
    let topo = region::topological_order(&proj.input)?;

    // Codes whose projection node is out of our block: abort/return blocks and
    // back-edge / out-of-region synthetic sinks. The elide step uses these to recognize
    // "this item terminates/leaves, so subsequent siblings only run when !item.guard"
    let sink_codes: HashSet<u64> = proj
        .input
        .iter()
        .filter_map(|(n, inp)| {
            if inp.edges().is_empty() {
                Some(n.index() as u64)
            } else {
                None
            }
        })
        .collect();

    // Initial AST: `Seq[ if(c_r(n_1)) { n_1 }; ...; if(c_r(n_k)) { n_k } ]` per NMG IV-B
    // step 1. Keep guards in their *factored* form (raw `And`/`Or` from the smart
    // constructors); calling `.simplify()` here distributes `And` over `Or` to DNF and
    // destroys the structure that lets the refinement step find compound factors like
    // a reaching condition shared as a top-level conjunct.
    let mut items: Vec<(Formula, D::Structured)> = Vec::with_capacity(topo.len());
    for n in topo {
        let guard = if n == entry {
            predicates::true_()
        } else {
            reach.get(&n).cloned().unwrap_or_else(predicates::true_)
        };
        // Drop a `False` guard, since it will never run.
        if guard == predicates::false_() {
            continue;
        }
        let body = to_structured_ast(n, &proj, structured_blocks, unstructured);
        items.push((guard, body));
    }

    // NMG IV-B step 2: condition-based refinement. See [IV-B.2] below.
    items = recover_control_flow(items, &sink_codes, &proj.input);

    // Final pass: collapse any remaining `Block(N) ; if(match_atom_k){...}` patterns that
    // implication-nesting buried inside Seq bodies (the refiner only consolidates at the
    // top of each recursive call's item list). We can skip the walk if there are no
    // `Variants` in the projection as an optimization.
    let mut body = D::Structured::from_guarded_items(items);
    let has_variants = proj
        .input
        .values()
        .any(|inp| matches!(inp, D::Input::Variants(..)));
    if has_variants {
        recover_switches_in_tree(&mut body, &proj.input);
    }
    Some(body)
}

fn structure_lexical_dag(
    proj: &AcyclicProjection,
    blocks: &BTreeMap<NodeIndex, D::Structured>,
    entry: NodeIndex,
    unstructured: &HashSet<u64>,
) -> Option<(D::Structured, HashSet<u64>)> {
    // Explicitly decline cycles, variants and multi-exit reduced regions. The
    // existing NMG path handles them; no speculative emissions are committed.
    let order = region::topological_order(&proj.input)?;
    fn breaks_to(body: &D::Structured, label: NodeIndex) -> bool {
        match body {
            D::Structured::Break(target) => *target == label,
            D::Structured::Seq(items) => items.iter().any(|s| breaks_to(s, label)),
            D::Structured::Loop(_, s) => breaks_to(s, label),
            D::Structured::CondIf(_, yes, no) => {
                breaks_to(yes, label) || no.as_ref().as_ref().is_some_and(|s| breaks_to(s, label))
            }
            D::Structured::Switch(_, _, arms) => arms.iter().any(|(_, s)| breaks_to(s, label)),
            D::Structured::SelectorMatch(_, arms) => arms.iter().any(|(_, s)| breaks_to(s, label)),
            _ => false,
        }
    }
    fn reachable(
        proj: &AcyclicProjection,
        start: NodeIndex,
        stops: &[(NodeIndex, NodeIndex)],
    ) -> HashSet<NodeIndex> {
        let mut reached = HashSet::new();
        let mut pending = vec![start];
        while let Some(n) = pending.pop() {
            if !reached.insert(n) || stops.iter().any(|(stop, _)| *stop == n) {
                continue;
            }
            pending.extend(
                proj.input
                    .get(&n)
                    .into_iter()
                    .flat_map(|b| b.edges().into_iter().map(|(_, to)| to)),
            );
        }
        reached
    }
    fn path(
        mut next: Option<NodeIndex>,
        stop: Option<NodeIndex>,
        proj: &AcyclicProjection,
        blocks: &BTreeMap<NodeIndex, D::Structured>,
        order: &[NodeIndex],
        seen: &mut HashSet<NodeIndex>,
        remaining: &mut HashSet<u64>,
        exits: &[(NodeIndex, NodeIndex)],
    ) -> Option<D::Structured> {
        let mut items = vec![];
        while next.is_some() && next != stop {
            let n = next?;
            if let Some((_, label)) = exits.iter().rev().find(|(target, _)| *target == n) {
                items.push(D::Structured::Break(*label));
                break;
            }
            // Exit jumps contain no original operations and may be reached
            // independently by several terminating branches.
            if let Some(exit) = proj.render_sink(n) {
                if stop.is_some() && matches!(proj.sinks[&n], region::SinkBehavior::Silent) {
                    return None;
                }
                seen.insert(n);
                items.push(exit);
                next = None;
                continue;
            }
            if !seen.insert(n) {
                return None;
            }
            let input = proj.input.get(&n)?;
            items.push(to_structured_ast(n, proj, blocks, remaining));
            match input {
                D::Input::Code(_, _, successor) => next = *successor,
                D::Input::Reduced(_, successors) if successors.len() <= 1 => {
                    next = successors.first().copied()
                }
                D::Input::Condition(_, code, yes, no) => {
                    // An early return/continue need not reach the join. Choose
                    // the first common reachable node, allowing terminal arms
                    // to finish before it. Shared real blocks are still emitted
                    // once; overlapping non-lexical shapes fail the seen check.
                    let yes_reach = reachable(proj, *yes, exits);
                    let no_reach = reachable(proj, *no, exits);
                    let join = order
                        .iter()
                        .copied()
                        .find(|j| {
                            !proj.sinks.contains_key(j)
                                && !exits.iter().any(|(target, _)| target == j)
                                && yes_reach.contains(j)
                                && no_reach.contains(j)
                        })
                        .or(stop);
                    // A one-iteration labeled region expresses a forward exit
                    // to an ancestor join without duplicating its operations.
                    // Original bytecode labels are u16 offsets; reserve a
                    // disjoint label range for these synthetic regions.
                    let label = NodeIndex::new(0x1000_0000 + n.index());
                    let wrap = join.is_some() && join != stop;
                    let mut child_exits = exits.to_vec();
                    if wrap {
                        child_exits.push((join.unwrap(), label));
                    }
                    let yes_body = path(
                        Some(*yes),
                        join,
                        proj,
                        blocks,
                        order,
                        seen,
                        remaining,
                        &child_exits,
                    )?;
                    let no_body = path(
                        Some(*no),
                        join,
                        proj,
                        blocks,
                        order,
                        seen,
                        remaining,
                        &child_exits,
                    )?;
                    let branch = D::Structured::CondIf(
                        predicates::cond_atom(*code),
                        Box::new(yes_body),
                        Box::new(Some(no_body)),
                    );
                    items.push(if wrap && breaks_to(&branch, label) {
                        D::Structured::Loop(
                            label,
                            Box::new(D::Structured::Seq(vec![
                                branch,
                                D::Structured::Break(label),
                            ])),
                        )
                    } else {
                        branch
                    });
                    next = join;
                }
                _ => return None,
            }
        }
        Some(D::Structured::Seq(items))
    }
    let mut seen = HashSet::new();
    let mut remaining = unstructured.clone();
    let body = path(
        Some(entry),
        None,
        proj,
        blocks,
        &order,
        &mut seen,
        &mut remaining,
        &[],
    )?;
    // Every projected node must be accounted for exactly once. In particular,
    // don't accept an overlap by cloning a shared continuation into both arms.
    if seen.len() != proj.input.len() {
        return None;
    }
    Some((body, remaining))
}

/// Translate `n` into a structured AST. Synthetic sinks emit exit-jumps (or empty for
/// whole-function); real nodes emit `Block(code)` (Code/Condition/Variants) or pull the
/// pre-structured form from `structured_blocks` (Reduced). Each `Block(code)` emission
/// records the code as structured by removing it from `unstructured`; Reduced inlines
/// don't touch the set (the inner pass that built the body did so when it ran).
fn to_structured_ast(
    n: NodeIndex,
    proj: &AcyclicProjection,
    structured_blocks: &BTreeMap<NodeIndex, D::Structured>,
    unstructured: &mut HashSet<u64>,
) -> D::Structured {
    if let Some(s) = proj.render_sink(n) {
        return s;
    }
    match proj.input.get(&n) {
        Some(D::Input::Code(_, code, _))
        | Some(D::Input::Condition(_, code, _, _))
        | Some(D::Input::Variants(_, code, _, _)) => {
            unstructured.remove(code);
            D::Structured::Block(*code)
        }
        Some(D::Input::Reduced(label, _)) => structured_blocks
            .get(label)
            .cloned()
            .expect("Reduced region must retain its structured body"),
        None => D::Structured::Seq(vec![]),
    }
}

// =================================================================================================
// Control flow recovery (NMG IV-B step 2)
// =================================================================================================

/// [IV-B.2] Iteratively apply NMG's refinement steps to a flat sequence of guarded items
/// until no more rewrites apply. Two phases per pass:
///
///   1. **Implication nesting**: when a later item's guard structurally implies an
///      earlier item's (via `has_factor`), nest the later item inside the earlier
///      one's body with a residual guard. This recovers Move's "definitely assigned"
///      structure - e.g. `__c27 = check; assert!(__c27)` lives inside the same
///      `if (__c24) { ... }` block so the read of `__c27` is on the path where it
///      was just written.
///
///   2. **Condition-based factoring**: factor out common literals / top-level
///      conjuncts across sibling guards. See [`factor_one_pass`].
///
/// Order matters: implication nesting first keeps related items together, so the
/// subsequent factoring doesn't drag a pair apart by picking a higher-coverage but
/// scope-fracturing factor.
fn recover_control_flow(
    mut items: Vec<(Formula, D::Structured)>,
    sink_codes: &HashSet<u64>,
    input: &BTreeMap<NodeIndex, D::Input>,
) -> Vec<(Formula, D::Structured)> {
    loop {
        if let Some(new_items) = nest_under_dominator(&items, sink_codes, input) {
            items = new_items;
            continue;
        }
        if let Some(new_items) = factor_one_pass(&items, sink_codes, input) {
            items = new_items;
            continue;
        }
        // Run elide LAST so factoring has reduced guards to small per-item residuals
        // before we feed them to QM. The assumption set is bounded by the depth of any
        // terminating `if (G) { abort }` patterns inside each item's body - small in
        // practice once refinement has pulled common factors up to outer scopes.
        if propagate_terminator_implications(&mut items, sink_codes) {
            continue;
        }
        if input
            .values()
            .any(|inp| matches!(inp, D::Input::Variants(..)))
        {
            return recover_switches_at_items(items, input);
        }
        return items;
    }
}

/// Walk items left-to-right tracking assumptions from each item's `if (guard) { body }`
/// role. When body always-terminates and the guard isn't `True`, subsequent siblings only
/// run when `!guard`. Harvests nested early-exits via `collect_terminator_assumptions`. If
/// accumulated assumptions imply an item's guard, set the guard to `True` so emission drops
/// the wrapper.
fn propagate_terminator_implications(
    items: &mut [(Formula, D::Structured)],
    sink_codes: &HashSet<u64>,
) -> bool {
    let mut changed = false;
    let mut assumptions: Vec<Formula> = Vec::new();
    for (guard, body) in items.iter_mut() {
        if *guard != predicates::true_() && guard.implied_by(&assumptions) {
            *guard = predicates::true_();
            changed = true;
        }
        // An item itself acts like `if (guard) { body }` at the surrounding scope; when
        // `body` always-terminates and `guard` isn't trivially `True`, subsequent items
        // only run when `!guard` - feed that into the accumulator.
        if *guard != predicates::true_() && body.always_terminates(sink_codes) {
            assumptions.push(predicates::not(guard.clone()));
        }
        // Harvest nested-Seq early-exits from inside `body`. The body sits inside the
        // item's wrapper, so use `[guard]` as the outer guard_stack - any local
        // assumption gets lifted to `guard -> local` for the surrounding sibling list.
        let body_stack: Vec<Formula> = if *guard == predicates::true_() {
            Vec::new()
        } else {
            vec![guard.clone()]
        };
        assumptions.extend(body.terminator_assumptions(&body_stack, sink_codes));
    }
    changed
}

/// Find the earliest item `i` such that one or more later items `j > i` have guards
/// that structurally factor through `guard(i)` (via [`Formula::has_factor`]). Those
/// implied items get pulled inside `i`'s body with their residual guards.
///
/// Skips items whose guard is `True` (the entry item) as the outer - nesting all
/// implied items inside the entry would be vacuous.
fn nest_under_dominator(
    items: &[(Formula, D::Structured)],
    sink_codes: &HashSet<u64>,
    input: &BTreeMap<NodeIndex, D::Input>,
) -> Option<Vec<(Formula, D::Structured)>> {
    for i in 0..items.len() {
        let g_i = &items[i].0;
        if *g_i == predicates::true_() {
            continue;
        }
        let implied: Vec<usize> = items
            .iter()
            .enumerate()
            .skip(i + 1)
            .filter_map(|(j, (g, _))| g.has_factor(g_i).then_some(j))
            .collect();
        if implied.is_empty() {
            continue;
        }

        // Inner items: each gets its guard's `g_i` factor stripped, then we recursively
        // refine the inner sequence so nested implications resolve too.
        let inner: Vec<(Formula, D::Structured)> = implied
            .iter()
            .map(|&j| (items[j].0.without_factor(g_i), items[j].1.clone()))
            .collect();
        let inner_refined = recover_control_flow(inner, sink_codes, input);
        let inner_seq = D::Structured::from_guarded_items(inner_refined);

        // Splice the original body and the new inner sequence into one Seq. Flatten
        // when either side is already a Seq so we don't pile up empty wrappers.
        let i_body = items[i].1.clone();
        let new_body = D::Structured::splice_seq(i_body, inner_seq);

        let implied_set: HashSet<usize> = implied.into_iter().collect();
        let mut new_items: Vec<(Formula, D::Structured)> = Vec::with_capacity(items.len());
        for (k, item) in items.iter().enumerate() {
            if k == i {
                new_items.push((g_i.clone(), new_body.clone()));
            } else if !implied_set.contains(&k) {
                new_items.push(item.clone());
            }
        }
        return Some(new_items);
    }
    None
}

/// One iteration of condition-based refinement. Returns `Some(refined)` if a
/// factoring happened, `None` if no candidate produced a refinement.
///
/// Strategy: scan literal candidates (atom or negated atom) that can be factored out of
/// 2+ items' guards via [`Formula::has_factor`] (which sees through DNF disjunctions).
/// For each candidate `c`, partition items into `Vc` (have `c` as factor) and `V_neg_c`
/// (have `!c` as factor). If `|Vc| + |V_neg_c| >= 2`, splice a
/// `CondIf(c, Seq(Vc with c stripped), Some(Seq(V_neg_c with !c stripped)))` at the
/// earliest affected position.
fn factor_one_pass(
    items: &[(Formula, D::Structured)],
    sink_codes: &HashSet<u64>,
    input: &BTreeMap<NodeIndex, D::Input>,
) -> Option<Vec<(Formula, D::Structured)>> {
    let candidates = candidate_factors(items);
    for c in candidates {
        let neg_c = predicates::not(c.clone());
        let mut vc_indices: Vec<usize> = Vec::new();
        let mut vneg_indices: Vec<usize> = Vec::new();
        for (i, (g, _)) in items.iter().enumerate() {
            if g.has_factor(&c) {
                vc_indices.push(i);
            } else if g.has_factor(&neg_c) {
                vneg_indices.push(i);
            }
        }
        if vc_indices.len() + vneg_indices.len() < 2 {
            continue;
        }

        // Children keep their R = guard \ factor. Don't `.simplify()` here -- it would
        // distribute the residual to DNF and break the next refinement layer's ability to
        // find compound factors.
        let vc_items: Vec<(Formula, D::Structured)> = vc_indices
            .iter()
            .map(|&i| {
                let (g, body) = &items[i];
                (g.without_factor(&c), body.clone())
            })
            .collect();
        let vneg_items: Vec<(Formula, D::Structured)> = vneg_indices
            .iter()
            .map(|&i| {
                let (g, body) = &items[i];
                (g.without_factor(&neg_c), body.clone())
            })
            .collect();
        let conseq =
            D::Structured::from_guarded_items(recover_control_flow(vc_items, sink_codes, input));
        let alt = if vneg_items.is_empty() {
            None
        } else {
            Some(D::Structured::from_guarded_items(recover_control_flow(
                vneg_items, sink_codes, input,
            )))
        };
        let compound = D::Structured::CondIf(c, Box::new(conseq), Box::new(alt));

        let earliest = vc_indices
            .iter()
            .chain(vneg_indices.iter())
            .min()
            .copied()
            .unwrap();
        let affected: HashSet<usize> = vc_indices.into_iter().chain(vneg_indices).collect();
        let mut new_items: Vec<(Formula, D::Structured)> = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            if i == earliest {
                new_items.push((predicates::true_(), compound.clone()));
            } else if !affected.contains(&i) {
                new_items.push(item.clone());
            }
        }
        return Some(new_items);
    }
    None
}

/// Collect factor candidates from `items` and score each by how many items it (or its
/// negation) factors out of.
///
/// Two sources of candidates so we get both atom-level factoring (inside DNF disjuncts)
/// and compound factoring (when an `Or` formula sits as a top-level conjunct alongside
/// atom factors):
///   - Every atom that appears anywhere in a guard - surfaces `__c38` even when guards
///     are `Or(And(...,__c38,...), And(...,__c38,...))`.
///   - Every top-level conjunct of each guard's `conjuncts()` - surfaces a compound
///     `Or` formula `g` when items have guards like `g`, `g && __c41`, `g && !__c41`.
///     Without this, the three items share `g` as a factor but no single atom is.
///
/// Order is fully deterministic: highest coverage first, then `Formula::Ord`.
fn candidate_factors(items: &[(Formula, D::Structured)]) -> Vec<Formula> {
    // `BTreeSet` (sorted) instead of `HashSet` so subsequent iteration order is fixed.
    let mut candidates: BTreeSet<Formula> = BTreeSet::new();
    for (g, _) in items {
        for s in g.atoms() {
            candidates.insert(predicates::atom(s));
        }
        for c in g.conjuncts() {
            candidates.insert(c);
        }
    }
    candidates.remove(&predicates::true_());
    candidates.remove(&predicates::false_());
    let mut scored: Vec<(Formula, usize)> = candidates
        .into_iter()
        .map(|c| {
            let neg = predicates::not(c.clone());
            let n = items
                .iter()
                .filter(|(g, _)| g.has_factor(&c) || g.has_factor(&neg))
                .count();
            (c, n)
        })
        .filter(|(_, n)| *n >= 2)
        .collect();
    scored.sort_by(|a, b| {
        // Higher count first; then `Formula::Ord` for total determinism.
        b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0))
    });
    // Dedup polarity: if both `c` and `!c` survived as candidates, keep the un-negated.
    let mut seen: BTreeSet<Formula> = BTreeSet::new();
    let mut out: Vec<Formula> = Vec::new();
    for (c, _) in scored {
        let neg = predicates::not(c.clone());
        if seen.contains(&c) || seen.contains(&neg) {
            continue;
        }
        seen.insert(c.clone());
        out.push(c);
    }
    out
}

// =================================================================================================
// Variants -> Switch recovery
// =================================================================================================
//
// At this stage, an enum `match` lives in the items list as a `Block(N)` for the
// Variants source, followed by per-arm `CondIf(match_atom(N, variant), body, None)`
// items, with an optional final item guarded by a disjunction of those match atoms (the
// post-Switch join). Recovery walks the list, identifies each Variants source by looking
// up `N` in the `input` map, gathers its arm items (which may not be contiguous after
// refinement - aborting arms tend to land past the join), and rebuilds the
// `Structured::Switch` together with its arm bodies.
//
// `recover_switches_at_items` runs at the items level inside `recover_control_flow`'s
// fixed-point loop. `recover_switches_in_tree` is a post-emission walk that catches
// nested Seqs where implication-nesting buried a Variants source inside an outer
// CondIf's body before the items-level pass got a chance to consolidate.

type EnumQid = (move_binary_format::normalized::ModuleId<Symbol>, Symbol);
type ArmSpecs = Vec<(Symbol, NodeIndex)>;

/// Look up the `Variants` entry in `input` whose body block has the given `code`. Returns
/// the enum's qualified identifier plus the (variant_name, target_block) list.
fn variants_with_code(
    input: &BTreeMap<NodeIndex, D::Input>,
    code: u64,
) -> Option<(EnumQid, ArmSpecs)> {
    input.values().find_map(|inp| match inp {
        D::Input::Variants(_, c, enum_, items) if *c == code => Some((*enum_, items.clone())),
        _ => None,
    })
}

/// The full set of match-atom names for a Variants's arms. Used to test whether a
/// downstream item's guard is a disjunction of this Switch's arm atoms (i.e. the join).
fn arm_atom_set(code: u64, arm_specs: &[(Symbol, NodeIndex)]) -> HashSet<Symbol> {
    arm_specs
        .iter()
        .map(|(v, _)| predicates::match_atom_name(code, v.as_str()))
        .collect()
}

/// Items-level recovery. Each item is `(Formula, Structured)`. The Variants source is the
/// item whose body is `Block(N)` for a Variants code; arm items are the items whose guard
/// equals `match_atom(N, variant)`; the join (optional) is an item whose guard simplifies
/// to a disjunction of those atoms.
fn recover_switches_at_items(
    items: Vec<(Formula, D::Structured)>,
    input: &BTreeMap<NodeIndex, D::Input>,
) -> Vec<(Formula, D::Structured)> {
    let mut slots: Vec<Option<(Formula, D::Structured)>> = items.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(slots.len());
    for i in 0..slots.len() {
        let Some(switch_recovery) = try_recover_items_switch_at(i, &mut slots, input) else {
            if let Some(item) = slots[i].take() {
                out.push(item);
            }
            continue;
        };
        let (head_guard, switch, arm_atoms) = switch_recovery;
        out.push((head_guard, switch));
        if let Some(join) = take_items_join(&mut slots, i + 1, &arm_atoms) {
            out.push((predicates::true_(), join));
        }
    }
    out
}

fn try_recover_items_switch_at(
    i: usize,
    slots: &mut [Option<(Formula, D::Structured)>],
    input: &BTreeMap<NodeIndex, D::Input>,
) -> Option<(Formula, D::Structured, HashSet<Symbol>)> {
    let (head_guard, code) = match slots[i].as_ref()? {
        (g, D::Structured::Block(c)) => (g.clone(), *c),
        _ => return None,
    };
    let (enum_, arm_specs) = variants_with_code(input, code)?;
    if arm_specs.is_empty() {
        return None;
    }
    let arms = collect_items_arms(&arm_specs, code, slots, i + 1)?;
    slots[i] = None;
    let arm_atoms = arm_atom_set(code, &arm_specs);
    Some((
        head_guard,
        D::Structured::Switch(code, enum_, arms),
        arm_atoms,
    ))
}

fn take_items_join(
    slots: &mut [Option<(Formula, D::Structured)>],
    start: usize,
    arm_atoms: &HashSet<Symbol>,
) -> Option<D::Structured> {
    let j = next_present(slots, start)?;
    let (g, _) = slots[j].as_ref()?;
    if g.is_disjunction_of_atoms(arm_atoms) {
        Some(slots[j].take().unwrap().1)
    } else {
        None
    }
}

/// Tree walk: recurse into nested Seq bodies and consolidate any Variants source whose
/// arm items are siblings in that Seq. Catches cases where implication-nesting moved a
/// Variants source inside a parent CondIf's body before items-level recovery saw it.
fn recover_switches_in_tree(s: &mut D::Structured, input: &BTreeMap<NodeIndex, D::Input>) {
    use D::Structured as DS;
    match s {
        DS::Seq(items) => {
            for item in items.iter_mut() {
                recover_switches_in_tree(item, input);
            }
            *items = recover_switches_in_seq(std::mem::take(items), input);
        }
        DS::CondIf(_, then, alt) => {
            recover_switches_in_tree(then, input);
            if let Some(a) = alt.as_mut().as_mut() {
                recover_switches_in_tree(a, input);
            }
        }
        DS::Loop(_, body) => recover_switches_in_tree(body, input),
        DS::Switch(_, _, arms) => {
            for (_, body) in arms.iter_mut() {
                recover_switches_in_tree(body, input);
            }
        }
        DS::SelectorMatch(_, arms) => {
            for (_, body) in arms.iter_mut() {
                recover_switches_in_tree(body, input);
            }
        }
        _ => {}
    }
}

/// Seq-level recovery. Each item is a bare `Structured`; arm items are `CondIf(atom, _,
/// None)` whose guard is a single match atom; the join (optional) is a `CondIf(disj, _,
/// None)` whose guard is the OR of arm atoms.
fn recover_switches_in_seq(
    items: Vec<D::Structured>,
    input: &BTreeMap<NodeIndex, D::Input>,
) -> Vec<D::Structured> {
    let mut slots: Vec<Option<D::Structured>> = items.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(slots.len());
    for i in 0..slots.len() {
        let Some(switch_recovery) = try_recover_seq_switch_at(i, &mut slots, input) else {
            if let Some(item) = slots[i].take() {
                out.push(item);
            }
            continue;
        };
        let (switch, arm_atoms) = switch_recovery;
        out.push(switch);
        if let Some(join) = take_seq_join(&mut slots, i + 1, &arm_atoms) {
            out.push(join);
        }
    }
    out
}

fn try_recover_seq_switch_at(
    i: usize,
    slots: &mut [Option<D::Structured>],
    input: &BTreeMap<NodeIndex, D::Input>,
) -> Option<(D::Structured, HashSet<Symbol>)> {
    let code = match slots[i].as_ref()? {
        D::Structured::Block(c) => *c,
        _ => return None,
    };
    let (enum_, arm_specs) = variants_with_code(input, code)?;
    if arm_specs.is_empty() {
        return None;
    }
    let arms = collect_seq_arms(&arm_specs, code, slots, i + 1)?;
    slots[i] = None;
    let arm_atoms = arm_atom_set(code, &arm_specs);
    Some((D::Structured::Switch(code, enum_, arms), arm_atoms))
}

fn take_seq_join(
    slots: &mut [Option<D::Structured>],
    start: usize,
    arm_atoms: &HashSet<Symbol>,
) -> Option<D::Structured> {
    let j = next_present(slots, start)?;
    let body = match slots[j].as_ref()? {
        D::Structured::CondIf(g, body, alt)
            if alt.as_ref().as_ref().is_none() && g.is_disjunction_of_atoms(arm_atoms) =>
        {
            Some(body.as_ref().clone())
        }
        _ => None,
    }?;
    slots[j] = None;
    Some(body)
}

/// Items-level arm collector: for each variant, scan `slots[start..]` for the first slot
/// whose guard formula equals that variant's match atom, take it, and use its `Structured`
/// half as the arm body. Variants without a matching slot get an empty `Seq` body.
/// Returns `None` if no variant matched (don't fabricate a Switch from just the head).
fn collect_items_arms(
    arm_specs: &[(Symbol, NodeIndex)],
    code: u64,
    slots: &mut [Option<(Formula, D::Structured)>],
    start: usize,
) -> Option<Vec<(Symbol, D::Structured)>> {
    let mut arms: Vec<(Symbol, D::Structured)> = Vec::with_capacity(arm_specs.len());
    let mut found_any = false;
    for (variant, _) in arm_specs {
        let atom = predicates::match_atom(code, variant.as_str());
        let mut body: Option<D::Structured> = None;
        for slot in slots.iter_mut().skip(start) {
            if slot.as_ref().is_some_and(|(g, _)| *g == atom) {
                body = Some(slot.take().unwrap().1);
                found_any = true;
                break;
            }
        }
        arms.push((*variant, body.unwrap_or_else(|| D::Structured::Seq(vec![]))));
    }
    found_any.then_some(arms)
}

/// Seq-level arm collector: for each variant, scan `slots[start..]` for the first slot
/// that's a `CondIf(atom, body, None)` whose guard is that variant's match atom; take it
/// and use `body` as the arm. Same empty-default / no-match-bail behavior as the
/// items-level collector.
fn collect_seq_arms(
    arm_specs: &[(Symbol, NodeIndex)],
    code: u64,
    slots: &mut [Option<D::Structured>],
    start: usize,
) -> Option<Vec<(Symbol, D::Structured)>> {
    let mut arms: Vec<(Symbol, D::Structured)> = Vec::with_capacity(arm_specs.len());
    let mut found_any = false;
    for (variant, _) in arm_specs {
        let atom = predicates::match_atom(code, variant.as_str());
        let mut body: Option<D::Structured> = None;
        for slot in slots.iter_mut().skip(start) {
            let matched = matches!(slot.as_ref(),
                Some(D::Structured::CondIf(g, _, alt))
                    if alt.as_ref().as_ref().is_none() && *g == atom);
            if matched {
                let D::Structured::CondIf(_, b, _) = slot.take().unwrap() else {
                    unreachable!()
                };
                body = Some(*b);
                found_any = true;
                break;
            }
        }
        arms.push((*variant, body.unwrap_or_else(|| D::Structured::Seq(vec![]))));
    }
    found_any.then_some(arms)
}

/// First `Some` index in `slots[start..]`, or `None` if all are taken.
fn next_present<S>(slots: &[Option<S>], start: usize) -> Option<usize> {
    (start..slots.len()).find(|&j| slots[j].is_some())
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    use crate::ast::Exp;
    use move_core_types::runtime_value::MoveValue;
    use move_stackless_bytecode_2::ast::PrimitiveOp;

    fn n(i: usize) -> NodeIndex {
        NodeIndex::new(i)
    }
    fn eval(e: &Exp, flags: &BTreeMap<String, bool>) -> bool {
        match e {
            Exp::Value(MoveValue::Bool(v)) => *v,
            Exp::Variable(v) => flags[v],
            Exp::Primitive {
                op: PrimitiveOp::Not,
                args,
            } => !eval(&args[0], flags),
            Exp::Primitive {
                op: PrimitiveOp::And,
                args,
            } => eval(&args[0], flags) && eval(&args[1], flags),
            Exp::Primitive {
                op: PrimitiveOp::Or,
                args,
            } => eval(&args[0], flags) || eval(&args[1], flags),
            _ => panic!("Unexpected predicate {e:?}"),
        }
    }
    fn execute(
        s: &D::Structured,
        input: &BTreeMap<NodeIndex, D::Input>,
        mask: u32,
        flags: &mut BTreeMap<String, bool>,
        trace: &mut Vec<u64>,
    ) -> Option<Option<NodeIndex>> {
        match s {
            D::Structured::Block(code) => {
                trace.push(*code);
                match &input[&n(*code as usize)] {
                    D::Input::Condition(..) => {
                        flags.insert(format!("__c{code}"), mask & (1 << code) != 0);
                        None
                    }
                    D::Input::Code(_, _, None) => Some(None),
                    _ => None,
                }
            }
            D::Structured::Seq(items) => items
                .iter()
                .find_map(|s| execute(s, input, mask, flags, trace)),
            D::Structured::CondIf(g, yes, no) => {
                if eval(&g.to_exp(), flags) {
                    execute(yes, input, mask, flags, trace)
                } else {
                    no.as_ref()
                        .as_ref()
                        .and_then(|s| execute(s, input, mask, flags, trace))
                }
            }
            D::Structured::Jump(_, target) => {
                trace.push(target.index() as u64);
                Some(None)
            }
            D::Structured::Break(label) => Some(Some(*label)),
            D::Structured::Loop(label, body) => match execute(body, input, mask, flags, trace) {
                Some(Some(target)) if target == *label => None,
                outcome => {
                    assert!(outcome.is_some(), "Synthetic region must exit");
                    outcome
                }
            },
            _ => panic!("Unexpected structured form"),
        }
    }
    fn check(input: BTreeMap<NodeIndex, D::Input>) {
        let members = input.keys().copied().collect();
        let mut missing = input.keys().map(|n| n.index() as u64).collect();
        let body = structure_region(
            &BTreeMap::new(),
            &input,
            n(0),
            &members,
            SinkRendering::Loop,
            &mut missing,
        )
        .unwrap();
        assert!(missing.is_empty());
        for mask in 0..8 {
            let mut expected = vec![];
            let mut next = Some(n(0));
            while let Some(node) = next {
                expected.push(node.index() as u64);
                next = match input.get(&node) {
                    Some(D::Input::Code(_, _, to)) => *to,
                    Some(D::Input::Condition(_, code, yes, no)) => {
                        Some(if mask & (1 << code) != 0 { *yes } else { *no })
                    }
                    None => None,
                    _ => panic!("Unexpected input"),
                };
            }
            // Unvisited predicates must be don't-cares: BOTH initial values
            // yield the exact original block/effect order on every path.
            for initial in [false, true] {
                let mut flags = (0..3).map(|i| (format!("__c{i}"), initial)).collect();
                let mut trace = vec![];
                execute(&body, &input, mask, &mut flags, &mut trace);
                assert_eq!(trace, expected, "mask={mask}, initial={initial}");
            }
        }
    }
    #[test]
    fn lexical_shared_exit_does_not_consume_ancestor_join() {
        check(BTreeMap::from([
            (n(0), D::Input::Condition(n(0), 0, n(1), n(2))),
            (n(1), D::Input::Condition(n(1), 1, n(3), n(99))),
            (n(2), D::Input::Condition(n(2), 2, n(4), n(99))),
            (n(3), D::Input::Code(n(3), 3, Some(n(6)))),
            (n(4), D::Input::Code(n(4), 4, Some(n(6)))),
            (n(6), D::Input::Code(n(6), 6, None)),
        ]));
    }
    #[test]
    fn overlapping_shared_paths_preserve_effect_order_for_all_predicates() {
        check(BTreeMap::from([
            (n(0), D::Input::Condition(n(0), 0, n(1), n(2))),
            (n(1), D::Input::Condition(n(1), 1, n(3), n(5))),
            (n(2), D::Input::Condition(n(2), 2, n(3), n(4))),
            (n(3), D::Input::Code(n(3), 3, Some(n(6)))),
            (n(4), D::Input::Code(n(4), 4, Some(n(6)))),
            (n(5), D::Input::Code(n(5), 5, Some(n(99)))),
            (n(6), D::Input::Code(n(6), 6, None)),
        ]));
    }
    #[test]
    fn forward_exit_skips_inner_join_and_emits_shared_return_once() {
        check(BTreeMap::from([
            (n(0), D::Input::Condition(n(0), 0, n(1), n(7))),
            (n(1), D::Input::Condition(n(1), 1, n(2), n(4))),
            (n(2), D::Input::Condition(n(2), 2, n(3), n(7))),
            (n(3), D::Input::Code(n(3), 3, Some(n(6)))),
            (n(4), D::Input::Code(n(4), 4, Some(n(6)))),
            (n(6), D::Input::Code(n(6), 6, Some(n(7)))),
            (n(7), D::Input::Code(n(7), 7, None)),
        ]));
    }
}
