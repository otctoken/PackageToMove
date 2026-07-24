const std = @import("std");
const cfg_mod = @import("cfg.zig");
const ast = @import("ast.zig");
const Allocator = std.mem.Allocator;
const BlockId = cfg_mod.BlockId;
const Node = ast.Node;

/// Structure a CFG into a high-level AST with if/else, loops, etc.
/// Uses a simplified version of the "No More Gotos" algorithm.
const StructError = Allocator.Error;

pub fn structure(
    allocator: Allocator,
    cfg: *const cfg_mod.Cfg,
    dom: *const cfg_mod.DominatorTree,
    loops: *const cfg_mod.LoopInfo,
) StructError!*const Node {
    if (cfg.blocks.len == 0) return makeNode(allocator, .empty);

    const visited = try allocator.alloc(bool, cfg.blocks.len);
    @memset(visited, false);
    return structureRegion(allocator, cfg, dom, loops, cfg.entry, null, null, visited);
}

fn structureRegion(
    allocator: Allocator,
    cfg: *const cfg_mod.Cfg,
    dom: *const cfg_mod.DominatorTree,
    loops: *const cfg_mod.LoopInfo,
    block_id: BlockId,
    loop_header: ?BlockId,
    stop_at: ?BlockId,
    visited: []bool,
) StructError!*const Node {
    if (stop_at != null and block_id == stop_at.?) return makeNode(allocator, .empty);

    // Prevent infinite recursion
    if (visited[block_id]) return makeNode(allocator, .{ .block = block_id });
    visited[block_id] = true;

    const block = cfg.blocks[block_id];

    if (loops.is_loop_header[block_id]) {
        return structureLoop(allocator, cfg, dom, loops, block_id, visited);
    }

    switch (block.terminator) {
        .ret => {
            return makeNode(allocator, .{ .block = block_id });
        },
        .abort => {
            return makeNode(allocator, .{ .block = block_id });
        },
        .jump => |target| {
            if (stop_at != null and target == stop_at.?) {
                return makeNode(allocator, .{ .block = block_id });
            }

            // Check if jump is to loop header (continue/break)
            if (loop_header) |lh| {
                if (target == lh) {
                    // Continue to loop header
                    var nodes = try allocator.alloc(*const Node, 2);
                    nodes[0] = try makeNode(allocator, .{ .block = block_id });
                    nodes[1] = try makeNode(allocator, .continue_);
                    return makeNode(allocator, .{ .seq = nodes });
                }
            }

            if (visited[target]) {
                return makeNode(allocator, .{ .block = block_id });
            }

            if (loop_header) |lh| {
                const target_in_loop = reachesHeader(cfg, target, lh, allocator) catch false;
                if (!target_in_loop) {
                    var nodes = try allocator.alloc(*const Node, 2);
                    nodes[0] = try makeNode(allocator, .{ .block = block_id });
                    nodes[1] = try makeNode(allocator, .break_);
                    return makeNode(allocator, .{ .seq = nodes });
                }
            }

            // Forward and branch-join edges inside a region are sequential.
            // `stop_at` prevents a branch from consuming its shared merge tail.
            {
                const rest = try structureRegion(allocator, cfg, dom, loops, target, loop_header, stop_at, visited);
                var nodes = try allocator.alloc(*const Node, 2);
                nodes[0] = try makeNode(allocator, .{ .block = block_id });
                nodes[1] = rest;
                return makeNode(allocator, .{ .seq = nodes });
            }
        },
        .branch => |br| {
            return structureBranch(allocator, cfg, dom, loops, block_id, br.then_id, br.else_id, loop_header, stop_at, visited);
        },
        .variant_switch => |targets| {
            const arms = try allocator.alloc(ast.MatchArm, targets.len);
            for (targets, 0..) |target_id, i| {
                const arm_node = try structureRegion(allocator, cfg, dom, loops, target_id, loop_header, stop_at, visited);
                arms[i] = .{ .body = arm_node };
            }
            return makeNode(allocator, .{ .match_ = .{ .cond_block = block_id, .arms = arms } });
        },
    }
}

fn structureBranch(
    allocator: Allocator,
    cfg: *const cfg_mod.Cfg,
    dom: *const cfg_mod.DominatorTree,
    loops: *const cfg_mod.LoopInfo,
    cond_block: BlockId,
    then_target: BlockId,
    else_target: BlockId,
    loop_header: ?BlockId,
    stop_at: ?BlockId,
    visited: []bool,
) StructError!*const Node {
    // A jump to the loop header is a real continue, not a branch merge.
    if (loop_header) |lh| {
        if (else_target == lh) {
            const then_body = try structureRegion(allocator, cfg, dom, loops, then_target, loop_header, stop_at, visited);
            return makeNode(allocator, .{ .if_else = .{
                .cond_block = cond_block,
                .then_branch = then_body,
                .else_branch = try makeNode(allocator, .continue_),
            } });
        }
        if (then_target == lh) {
            const else_body = try structureRegion(allocator, cfg, dom, loops, else_target, loop_header, stop_at, visited);
            return makeNode(allocator, .{ .if_else = .{
                .cond_block = cond_block,
                .then_branch = try makeNode(allocator, .continue_),
                .else_branch = else_body,
            } });
        }
    }

    // Structure each branch only up to its nearest common continuation.
    const merge = try findNearestMerge(allocator, cfg, dom, cond_block, then_target, else_target, loop_header);
    const arm_stop = merge orelse stop_at;
    const then_visited = try allocator.dupe(bool, visited);
    const else_visited = try allocator.dupe(bool, visited);
    const then_node = try structureRegion(allocator, cfg, dom, loops, then_target, loop_header, arm_stop, then_visited);
    const else_node = try structureRegion(allocator, cfg, dom, loops, else_target, loop_header, arm_stop, else_visited);
    const if_node = try makeNode(allocator, .{ .if_else = .{
        .cond_block = cond_block,
        .then_branch = then_node,
        .else_branch = else_node,
    } });

    if (merge) |merge_id| {
        if (stop_at != null and merge_id == stop_at.?) return if_node;
        const rest = try structureRegion(allocator, cfg, dom, loops, merge_id, loop_header, stop_at, visited);
        var nodes = try allocator.alloc(*const Node, 2);
        nodes[0] = if_node;
        nodes[1] = rest;
        return makeNode(allocator, .{ .seq = nodes });
    }
    return if_node;
}

fn structureBranchLegacy(
    allocator: Allocator,
    cfg: *const cfg_mod.Cfg,
    dom: *const cfg_mod.DominatorTree,
    loops: *const cfg_mod.LoopInfo,
    cond_block: BlockId,
    then_target: BlockId,
    else_target: BlockId,
    loop_header: ?BlockId,
    stop_at: ?BlockId,
    visited: []bool,
) StructError!*const Node {
    // Check if this is a while loop condition (then or else goes to loop header)
    if (loop_header) |lh| {
        if (else_target == lh) {
            // while (cond) { then_branch } — else continues loop
            const then_body = try structureRegion(allocator, cfg, dom, loops, then_target, loop_header, stop_at, visited);
            var nodes = try allocator.alloc(*const Node, 2);
            nodes[0] = try makeNode(allocator, .{ .block = cond_block });
            nodes[1] = then_body;
            const body = try makeNode(allocator, .{ .seq = nodes });
            _ = body;
            // This pattern means: if (cond) { then } else { continue }
            const else_node = try makeNode(allocator, .continue_);
            return makeNode(allocator, .{ .if_else = .{
                .cond_block = cond_block,
                .then_branch = then_body,
                .else_branch = else_node,
            } });
        }
        if (then_target == lh) {
            const else_body = try structureRegion(allocator, cfg, dom, loops, else_target, loop_header, stop_at, visited);
            const then_node = try makeNode(allocator, .continue_);
            return makeNode(allocator, .{ .if_else = .{
                .cond_block = cond_block,
                .then_branch = then_node,
                .else_branch = else_body,
            } });
        }
    }

    // Find post-dominator (merge point)
    // Simple heuristic: if one branch dominates the other's target, it's the merge
    const then_dominated = dom.idom[then_target] == cond_block;
    const else_dominated = dom.idom[else_target] == cond_block;

    if (then_dominated and else_dominated) {
        // Both branches are dominated — full if/else
        const then_node = try structureRegion(allocator, cfg, dom, loops, then_target, loop_header, visited);
        const else_node = try structureRegion(allocator, cfg, dom, loops, else_target, loop_header, visited);

        // Find merge point: block dominated by cond that's a successor of both branches
        const merge = findMergePoint(cfg, dom, cond_block, then_target, else_target);

        var parts = std.ArrayList(*const Node){};
        try parts.append(allocator, try makeNode(allocator, .{ .if_else = .{
            .cond_block = cond_block,
            .then_branch = then_node,
            .else_branch = else_node,
        } }));

        if (merge) |merge_id| {
            if (merge_id != then_target and merge_id != else_target) {
                const rest = try structureRegion(allocator, cfg, dom, loops, merge_id, loop_header, visited);
                try parts.append(allocator, rest);
            }
        }

        if (parts.items.len == 1) return parts.items[0];
        return makeNode(allocator, .{ .seq = parts.items });
    }

    if (then_dominated) {
        // Only then branch is dominated — if-then with else as merge
        const then_node = try structureRegion(allocator, cfg, dom, loops, then_target, loop_header, visited);
        const if_node = try makeNode(allocator, .{ .if_else = .{
            .cond_block = cond_block,
            .then_branch = then_node,
            .else_branch = null,
        } });

        // Continue with else target
        const rest = try structureRegion(allocator, cfg, dom, loops, else_target, loop_header, visited);
        var nodes = try allocator.alloc(*const Node, 2);
        nodes[0] = if_node;
        nodes[1] = rest;
        return makeNode(allocator, .{ .seq = nodes });
    }

    if (else_dominated) {
        // Only else branch is dominated — if(!cond)-then with then as merge
        const else_node = try structureRegion(allocator, cfg, dom, loops, else_target, loop_header, visited);
        const if_node = try makeNode(allocator, .{ .if_else = .{
            .cond_block = cond_block,
            .then_branch = try makeNode(allocator, .empty),
            .else_branch = else_node,
        } });

        const rest = try structureRegion(allocator, cfg, dom, loops, then_target, loop_header, visited);
        var nodes = try allocator.alloc(*const Node, 2);
        nodes[0] = if_node;
        nodes[1] = rest;
        return makeNode(allocator, .{ .seq = nodes });
    }

    // Neither dominated — just emit the block as-is
    return makeNode(allocator, .{ .block = cond_block });
}

fn structureLoop(
    allocator: Allocator,
    cfg: *const cfg_mod.Cfg,
    dom: *const cfg_mod.DominatorTree,
    loops: *const cfg_mod.LoopInfo,
    header: BlockId,
    visited: []bool,
) StructError!*const Node {
    const block = cfg.blocks[header];

    // Create fresh visited set for loop body — blocks inside the loop
    // haven't been visited in this loop's context
    const loop_visited = try allocator.alloc(bool, visited.len);
    @memcpy(loop_visited, visited);

    switch (block.terminator) {
        .branch => |br| {
            // Check if one branch leads back to loop header (is in the loop body).
            // "In loop" = there exists a path from the target back to the header,
            // not just domination (which includes the exit block).
            const then_in_loop = reachesHeader(cfg, br.then_id, header, allocator) catch false;
            const else_in_loop = reachesHeader(cfg, br.else_id, header, allocator) catch false;

            if (then_in_loop and !else_in_loop) {
                // while (cond) { body } — else exits
                const body = try structureRegion(allocator, cfg, dom, loops, br.then_id, header, null, loop_visited);
                const while_node = try makeNode(allocator, .{ .while_loop = .{
                    .cond_block = header,
                    .body = body,
                } });

                // Continue after loop with the exit target
                const rest = try structureRegion(allocator, cfg, dom, loops, br.else_id, null, null, visited);
                var nodes = try allocator.alloc(*const Node, 2);
                nodes[0] = while_node;
                nodes[1] = rest;
                return makeNode(allocator, .{ .seq = nodes });
            }

            if (!then_in_loop and else_in_loop) {
                // while (!cond) { body } — then exits
                const body = try structureRegion(allocator, cfg, dom, loops, br.else_id, header, null, loop_visited);
                const while_node = try makeNode(allocator, .{ .while_loop = .{
                    .cond_block = header,
                    .body = body,
                } });

                const rest = try structureRegion(allocator, cfg, dom, loops, br.then_id, null, null, visited);
                var nodes = try allocator.alloc(*const Node, 2);
                nodes[0] = while_node;
                nodes[1] = rest;
                return makeNode(allocator, .{ .seq = nodes });
            }

            // Both in loop — infinite loop with break
            const body = try structureRegion(allocator, cfg, dom, loops, header, header, null, loop_visited);
            return makeNode(allocator, .{ .loop_ = .{ .body = body } });
        },
        .jump => |target| {
            if (target == header) {
                // Tight infinite loop: loop { block }
                return makeNode(allocator, .{ .loop_ = .{
                    .body = try makeNode(allocator, .{ .block = header }),
                } });
            }
            // Loop with body
            const body = try structureRegion(allocator, cfg, dom, loops, target, header, null, loop_visited);
            var inner = try allocator.alloc(*const Node, 2);
            inner[0] = try makeNode(allocator, .{ .block = header });
            inner[1] = body;
            return makeNode(allocator, .{ .loop_ = .{
                .body = try makeNode(allocator, .{ .seq = inner }),
            } });
        },
        else => {
            return makeNode(allocator, .{ .block = header });
        },
    }
}

/// Check if there's a path from `start` back to `header` (i.e., start is in the loop body).
fn reachesHeader(cfg: *const cfg_mod.Cfg, start: BlockId, header: BlockId, allocator: Allocator) !bool {
    if (start == header) return true;
    const n = cfg.blocks.len;
    const visited_r = try allocator.alloc(bool, n);
    @memset(visited_r, false);

    var work = std.ArrayList(BlockId){};
    try work.append(allocator, start);
    visited_r[start] = true;

    while (work.items.len > 0) {
        const b = work.pop() orelse break;
        const block = cfg.blocks[b];
        const succs: []const BlockId = switch (block.terminator) {
            .jump => |t| &[_]BlockId{t},
            .branch => |br| &[_]BlockId{ br.then_id, br.else_id },
            .ret, .abort => &[_]BlockId{},
            .variant_switch => |targets| targets,
        };
        for (succs) |s| {
            if (s == header) return true;
            if (!visited_r[s]) {
                visited_r[s] = true;
                try work.append(allocator, s);
            }
        }
    }
    return false;
}

fn findNearestMerge(
    allocator: Allocator,
    cfg: *const cfg_mod.Cfg,
    dom: *const cfg_mod.DominatorTree,
    cond: BlockId,
    then_target: BlockId,
    else_target: BlockId,
    loop_header: ?BlockId,
) StructError!?BlockId {
    const then_dist = try reachableDistances(allocator, cfg, then_target, loop_header);
    const else_dist = try reachableDistances(allocator, cfg, else_target, loop_header);
    const unreachable_distance: u32 = std.math.maxInt(u32);

    var best: ?BlockId = null;
    var best_max = unreachable_distance;
    var best_sum = unreachable_distance;
    for (0..cfg.blocks.len) |index| {
        const candidate: BlockId = @intCast(index);
        if (candidate == cond) continue;
        if (loop_header != null and candidate == loop_header.?) continue;
        if (then_dist[index] == unreachable_distance or else_dist[index] == unreachable_distance) continue;
        if (!dom.dominates(cond, candidate)) continue;

        const max_dist = @max(then_dist[index], else_dist[index]);
        const sum_dist = then_dist[index] + else_dist[index];
        if (max_dist < best_max or (max_dist == best_max and sum_dist < best_sum)) {
            best = candidate;
            best_max = max_dist;
            best_sum = sum_dist;
        }
    }
    return best;
}

fn reachableDistances(
    allocator: Allocator,
    cfg: *const cfg_mod.Cfg,
    start: BlockId,
    blocked: ?BlockId,
) StructError![]u32 {
    const unreachable_distance: u32 = std.math.maxInt(u32);
    const distances = try allocator.alloc(u32, cfg.blocks.len);
    @memset(distances, unreachable_distance);
    distances[start] = 0;

    var queue = std.ArrayList(BlockId){};
    try queue.append(allocator, start);
    var cursor: usize = 0;
    while (cursor < queue.items.len) : (cursor += 1) {
        const current = queue.items[cursor];
        const block = cfg.blocks[current];
        const successors: []const BlockId = switch (block.terminator) {
            .jump => |target| &[_]BlockId{target},
            .branch => |br| &[_]BlockId{ br.then_id, br.else_id },
            .ret, .abort => &[_]BlockId{},
            .variant_switch => |targets| targets,
        };
        for (successors) |successor| {
            if (blocked != null and successor == blocked.?) continue;
            if (distances[successor] != unreachable_distance) continue;
            distances[successor] = distances[current] + 1;
            try queue.append(allocator, successor);
        }
    }
    return distances;
}

fn findMergePoint(
    cfg: *const cfg_mod.Cfg,
    dom: *const cfg_mod.DominatorTree,
    cond: BlockId,
    then_target: BlockId,
    else_target: BlockId,
) ?BlockId {
    _ = cfg;
    // Simple: find a common child in dominator tree that isn't then or else
    for (dom.children[cond]) |child| {
        if (child != then_target and child != else_target) {
            return child;
        }
    }
    return null;
}

fn makeNode(allocator: Allocator, value: Node) StructError!*const Node {
    const node = try allocator.create(Node);
    node.* = value;
    return node;
}

// ── Tests ─────────────────────────────────────────────────────────────

const testing = std.testing;
const binary = @import("binary.zig");

test "structure: simple function produces block node" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = @embedFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    // total_supply: 4 sequential instructions, no branches
    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        if (std.mem.eql(u8, module.identifiers[fh.name], "total_supply")) {
            const cfg = try cfg_mod.buildCfg(alloc, fd.code.?.code, fd.code.?.jump_tables);
            const dom = try cfg_mod.computeDominators(alloc, &cfg);
            const loops = try cfg_mod.detectLoops(alloc, &cfg, &dom);
            const result = try structure(alloc, &cfg, &dom, &loops);
            try testing.expectEqual(Node{ .block = 0 }, result.*);
            return;
        }
    }
}

test "structure: function with branches produces if_else" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = @embedFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    // create_currency has branches
    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        if (std.mem.eql(u8, module.identifiers[fh.name], "create_currency")) {
            const cfg = try cfg_mod.buildCfg(alloc, fd.code.?.code, fd.code.?.jump_tables);
            if (cfg.blocks.len > 1) {
                const dom = try cfg_mod.computeDominators(alloc, &cfg);
                const loops = try cfg_mod.detectLoops(alloc, &cfg, &dom);
                const result = try structure(alloc, &cfg, &dom, &loops);
                // Should produce structured output (not just a flat block)
                // Should produce structured output, not just a single flat block
                try testing.expect(result.* != .empty);
                return;
            }
        }
    }
}

test "structure: divide_into_n produces while loop" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = @embedFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        if (std.mem.eql(u8, module.identifiers[fh.name], "divide_into_n")) {
            const cfg = try cfg_mod.buildCfg(alloc, fd.code.?.code, fd.code.?.jump_tables);
            const dom = try cfg_mod.computeDominators(alloc, &cfg);
            const loops = try cfg_mod.detectLoops(alloc, &cfg, &dom);
            const result = try structure(alloc, &cfg, &dom, &loops);

            // Should contain a while_loop or loop_ somewhere
            try testing.expect(containsLoop(result));
            return;
        }
    }
}

test "structure: branch merge inside loop is not a break" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    // while (header) {
    //     if (cond) { left } else { right }
    //     tail;
    // }
    const blocks = [_]cfg_mod.BasicBlock{
        .{ .id = 0, .start = 0, .end = 1, .terminator = .{ .branch = .{ .then_id = 1, .else_id = 5 } } },
        .{ .id = 1, .start = 1, .end = 2, .terminator = .{ .branch = .{ .then_id = 2, .else_id = 3 } } },
        .{ .id = 2, .start = 2, .end = 3, .terminator = .{ .jump = 4 } },
        .{ .id = 3, .start = 3, .end = 4, .terminator = .{ .jump = 4 } },
        .{ .id = 4, .start = 4, .end = 5, .terminator = .{ .jump = 0 } },
        .{ .id = 5, .start = 5, .end = 6, .terminator = .ret },
    };
    const pred0 = [_]BlockId{4};
    const pred1 = [_]BlockId{0};
    const pred2 = [_]BlockId{1};
    const pred3 = [_]BlockId{1};
    const pred4 = [_]BlockId{ 2, 3 };
    const pred5 = [_]BlockId{0};
    const preds = [_][]const BlockId{ &pred0, &pred1, &pred2, &pred3, &pred4, &pred5 };
    const graph = cfg_mod.Cfg{ .blocks = &blocks, .entry = 0, .preds = &preds };
    const dom = try cfg_mod.computeDominators(alloc, &graph);
    const loops = try cfg_mod.detectLoops(alloc, &graph, &dom);
    const result = try structure(alloc, &graph, &dom, &loops);

    try testing.expect(containsLoop(result));
    try testing.expect(!containsBreak(result));
}

fn containsLoop(node: *const Node) bool {
    switch (node.*) {
        .while_loop, .loop_ => return true,
        .seq => |nodes| {
            for (nodes) |n| {
                if (containsLoop(n)) return true;
            }
            return false;
        },
        .if_else => |ie| {
            if (containsLoop(ie.then_branch)) return true;
            if (ie.else_branch) |eb| return containsLoop(eb);
            return false;
        },
        else => return false,
    }
}

fn containsBreak(node: *const Node) bool {
    switch (node.*) {
        .break_ => return true,
        .seq => |nodes| {
            for (nodes) |child| {
                if (containsBreak(child)) return true;
            }
            return false;
        },
        .if_else => |branch| {
            if (containsBreak(branch.then_branch)) return true;
            if (branch.else_branch) |else_branch| return containsBreak(else_branch);
            return false;
        },
        .while_loop => |loop| return containsBreak(loop.body),
        .loop_ => |loop| return containsBreak(loop.body),
        .match_ => |match| {
            for (match.arms) |arm| {
                if (containsBreak(arm.body)) return true;
            }
            return false;
        },
        else => return false,
    }
}
