const types = @import("types.zig");
const cfg_mod = @import("cfg.zig");

/// Structured AST node — the output of the structuring algorithm.
/// Represents control flow that has been recovered from the flat CFG.
pub const Node = union(enum) {
    /// A basic block of sequential bytecode instructions
    block: cfg_mod.BlockId,
    /// Sequential composition: execute nodes in order
    seq: []const *const Node,
    /// If-then-else
    if_else: struct {
        /// Block containing the condition (last instruction is the branch)
        cond_block: cfg_mod.BlockId,
        then_branch: *const Node,
        else_branch: ?*const Node,
    },
    /// While loop with condition
    while_loop: struct {
        cond_block: cfg_mod.BlockId,
        body: *const Node,
    },
    /// Infinite loop (loop { ... })
    loop_: struct {
        body: *const Node,
    },
    /// Match/switch on enum variant
    match_: struct {
        /// Block containing the variant_switch instruction
        cond_block: cfg_mod.BlockId,
        /// One branch per variant
        arms: []const MatchArm,
    },
    /// Break from enclosing loop
    break_,
    /// Continue to enclosing loop header
    continue_,
    /// Return statement
    return_,
    /// Empty node
    empty,
};

pub const MatchArm = struct {
    body: *const Node,
};
