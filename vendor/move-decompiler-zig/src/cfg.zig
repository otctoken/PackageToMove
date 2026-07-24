const std = @import("std");
const types = @import("types.zig");
const Allocator = std.mem.Allocator;

// ── Basic Block & CFG Types ───────────────────────────────────────────

pub const BlockId = u16;

pub const Terminator = union(enum) {
    /// Fall through or unconditional jump to one target
    jump: BlockId,
    /// Conditional branch: if (cond) then_id else else_id
    branch: struct { then_id: BlockId, else_id: BlockId },
    /// Return from function
    ret,
    /// Abort execution
    abort,
    /// Variant switch (enum match) — v7+
    variant_switch: []const BlockId,
};

pub const BasicBlock = struct {
    id: BlockId,
    /// Range of bytecode instructions [start..end)
    start: u16,
    end: u16,
    terminator: Terminator,
};

pub const Cfg = struct {
    blocks: []const BasicBlock,
    entry: BlockId,
    /// Predecessors for each block: preds[block_id] = list of predecessor block IDs
    preds: []const []const BlockId,
};

// ── CFG Builder ───────────────────────────────────────────────────────

pub fn buildCfg(allocator: Allocator, code: []const types.Bytecode, jump_tables: []const types.VariantJumpTable) !Cfg {
    if (code.len == 0) {
        const block = try allocator.create(BasicBlock);
        block.* = .{ .id = 0, .start = 0, .end = 0, .terminator = .ret };
        const blocks = try allocator.alloc(BasicBlock, 1);
        blocks[0] = block.*;
        const preds = try allocator.alloc([]const BlockId, 1);
        preds[0] = &.{};
        return .{ .blocks = blocks, .entry = 0, .preds = preds };
    }

    // Step 1: Find leaders (first instructions of basic blocks)
    var leaders = std.AutoHashMap(u16, void).init(allocator);
    defer leaders.deinit();
    try leaders.put(0, {}); // Entry is always a leader

    for (code, 0..) |instr, i| {
        const idx: u16 = @intCast(i);
        switch (instr) {
            .br_true => |target| {
                try leaders.put(target, {});
                if (idx + 1 < code.len) try leaders.put(idx + 1, {});
            },
            .br_false => |target| {
                try leaders.put(target, {});
                if (idx + 1 < code.len) try leaders.put(idx + 1, {});
            },
            .branch => |target| {
                try leaders.put(target, {});
                if (idx + 1 < code.len) try leaders.put(idx + 1, {});
            },
            .ret, .abort => {
                if (idx + 1 < code.len) try leaders.put(idx + 1, {});
            },
            .variant_switch => |jt_idx| {
                // Register all jump table target offsets as leaders
                if (jt_idx < jump_tables.len) {
                    for (jump_tables[jt_idx].offsets) |target| {
                        try leaders.put(target, {});
                    }
                }
                if (idx + 1 < code.len) try leaders.put(idx + 1, {});
            },
            else => {},
        }
    }

    // Step 2: Sort leaders and build blocks
    var leader_list = std.ArrayList(u16){};
    defer leader_list.deinit(allocator);
    var it = leaders.keyIterator();
    while (it.next()) |key| {
        if (key.* < code.len) try leader_list.append(allocator, key.*);
    }
    std.mem.sort(u16, leader_list.items, {}, std.sort.asc(u16));

    // Map: instruction offset → block id
    var offset_to_block = std.AutoHashMap(u16, BlockId).init(allocator);
    defer offset_to_block.deinit();
    for (leader_list.items, 0..) |leader, i| {
        try offset_to_block.put(leader, @intCast(i));
    }

    const num_blocks: usize = leader_list.items.len;
    const blocks = try allocator.alloc(BasicBlock, num_blocks);

    for (leader_list.items, 0..) |leader, i| {
        const block_id: BlockId = @intCast(i);
        const start = leader;
        const end: u16 = if (i + 1 < num_blocks)
            leader_list.items[i + 1]
        else
            @intCast(code.len);

        // Determine terminator from last instruction
        const last_instr = code[end - 1];
        const terminator: Terminator = switch (last_instr) {
            .branch => |target| .{ .jump = offset_to_block.get(target) orelse 0 },
            .br_true => |target| blk: {
                const then_id = offset_to_block.get(target) orelse 0;
                const else_id = if (block_id + 1 < num_blocks) block_id + 1 else 0;
                break :blk .{ .branch = .{ .then_id = then_id, .else_id = else_id } };
            },
            .br_false => |target| blk: {
                const false_id = offset_to_block.get(target) orelse 0;
                const true_id = if (block_id + 1 < num_blocks) block_id + 1 else 0;
                // br_false: if false goto target, else fall through
                break :blk .{ .branch = .{ .then_id = true_id, .else_id = false_id } };
            },
            .variant_switch => |jt_idx| blk: {
                if (jt_idx < jump_tables.len) {
                    const jt = jump_tables[jt_idx];
                    const targets = try allocator.alloc(BlockId, jt.offsets.len);
                    for (jt.offsets, 0..) |target_offset, ti| {
                        targets[ti] = offset_to_block.get(target_offset) orelse 0;
                    }
                    break :blk .{ .variant_switch = targets };
                } else {
                    // Fallthrough if jump table missing
                    if (block_id + 1 < num_blocks)
                        break :blk .{ .jump = block_id + 1 }
                    else
                        break :blk .ret;
                }
            },
            .ret => .ret,
            .abort => .abort,
            else => blk: {
                // Fallthrough to next block
                if (block_id + 1 < num_blocks)
                    break :blk .{ .jump = block_id + 1 }
                else
                    break :blk .ret; // Last block with no explicit terminator
            },
        };

        blocks[i] = .{
            .id = block_id,
            .start = start,
            .end = end,
            .terminator = terminator,
        };
    }

    // Step 3: Build predecessor lists
    const preds = try allocator.alloc([]const BlockId, num_blocks);
    var pred_lists = try allocator.alloc(std.ArrayList(BlockId), num_blocks);
    for (0..num_blocks) |i| {
        pred_lists[i] = std.ArrayList(BlockId){};
    }

    for (blocks) |block| {
        switch (block.terminator) {
            .jump => |target| try pred_lists[target].append(allocator, block.id),
            .branch => |br| {
                try pred_lists[br.then_id].append(allocator, block.id);
                try pred_lists[br.else_id].append(allocator, block.id);
            },
            .variant_switch => |targets| {
                for (targets) |target| {
                    try pred_lists[target].append(allocator, block.id);
                }
            },
            .ret, .abort => {},
        }
    }

    for (0..num_blocks) |i| {
        preds[i] = pred_lists[i].items;
    }

    return .{ .blocks = blocks, .entry = 0, .preds = preds };
}

// ── Dominator Tree ────────────────────────────────────────────────────

pub const DominatorTree = struct {
    /// idom[block_id] = immediate dominator block id (idom[entry] = entry)
    idom: []const BlockId,
    /// Children in the dominator tree
    children: []const []const BlockId,

    /// Check if a dominates b
    pub fn dominates(self: *const DominatorTree, a: BlockId, b: BlockId) bool {
        if (a == b) return true;
        var current = b;
        while (current != self.idom[current]) {
            current = self.idom[current];
            if (current == a) return true;
        }
        return false;
    }
};

/// Cooper-Harvey-Kennedy algorithm for computing dominators
pub fn computeDominators(allocator: Allocator, cfg: *const Cfg) !DominatorTree {
    const n = cfg.blocks.len;
    if (n == 0) return .{ .idom = &.{}, .children = &.{} };

    // Compute reverse post-order
    const rpo = try reversePostOrder(allocator, cfg);
    defer allocator.free(rpo);

    // rpo_idx[block_id] = index in RPO (lower = earlier)
    const rpo_idx = try allocator.alloc(u16, n);
    defer allocator.free(rpo_idx);
    for (rpo, 0..) |block_id, i| {
        rpo_idx[block_id] = @intCast(i);
    }

    // Initialize idom
    const idom = try allocator.alloc(BlockId, n);
    const UNDEFINED: BlockId = std.math.maxInt(BlockId);
    @memset(idom, UNDEFINED);
    idom[cfg.entry] = cfg.entry;

    // Iterative dominator computation
    var changed = true;
    while (changed) {
        changed = false;
        for (rpo) |b| {
            if (b == cfg.entry) continue;

            var new_idom: BlockId = UNDEFINED;
            for (cfg.preds[b]) |p| {
                if (idom[p] == UNDEFINED) continue;
                if (new_idom == UNDEFINED) {
                    new_idom = p;
                } else {
                    new_idom = intersect(idom, rpo_idx, new_idom, p);
                }
            }

            if (new_idom != UNDEFINED and idom[b] != new_idom) {
                idom[b] = new_idom;
                changed = true;
            }
        }
    }

    // Build children lists
    const children = try allocator.alloc([]const BlockId, n);
    var child_lists = try allocator.alloc(std.ArrayList(BlockId), n);
    for (0..n) |i| {
        child_lists[i] = std.ArrayList(BlockId){};
    }
    for (0..n) |i| {
        const b: BlockId = @intCast(i);
        if (idom[b] != b and idom[b] != UNDEFINED) {
            try child_lists[idom[b]].append(allocator, b);
        }
    }
    for (0..n) |i| {
        children[i] = child_lists[i].items;
    }

    return .{ .idom = idom, .children = children };
}

fn intersect(idom: []const BlockId, rpo_idx: []const u16, a: BlockId, b: BlockId) BlockId {
    var finger1 = a;
    var finger2 = b;
    while (finger1 != finger2) {
        while (rpo_idx[finger1] > rpo_idx[finger2]) {
            finger1 = idom[finger1];
        }
        while (rpo_idx[finger2] > rpo_idx[finger1]) {
            finger2 = idom[finger2];
        }
    }
    return finger1;
}

fn reversePostOrder(allocator: Allocator, cfg: *const Cfg) ![]BlockId {
    const n = cfg.blocks.len;
    var visited = try allocator.alloc(bool, n);
    defer allocator.free(visited);
    @memset(visited, false);

    var order = std.ArrayList(BlockId){};

    // DFS post-order
    var stack = std.ArrayList(struct { id: BlockId, expanded: bool }){};
    defer stack.deinit(allocator);
    try stack.append(allocator, .{ .id = cfg.entry, .expanded = false });

    while (stack.items.len > 0) {
        const top = &stack.items[stack.items.len - 1];
        if (visited[top.id] and !top.expanded) {
            _ = stack.pop();
            continue;
        }
        if (top.expanded) {
            try order.append(allocator, top.id);
            _ = stack.pop();
            continue;
        }
        visited[top.id] = true;
        top.expanded = true;

        // Push successors
        const block = cfg.blocks[top.id];
        switch (block.terminator) {
            .jump => |target| {
                if (!visited[target])
                    try stack.append(allocator, .{ .id = target, .expanded = false });
            },
            .branch => |br| {
                // Push else first so then is processed first
                if (!visited[br.else_id])
                    try stack.append(allocator, .{ .id = br.else_id, .expanded = false });
                if (!visited[br.then_id])
                    try stack.append(allocator, .{ .id = br.then_id, .expanded = false });
            },
            .variant_switch => |targets| {
                var i = targets.len;
                while (i > 0) {
                    i -= 1;
                    if (!visited[targets[i]])
                        try stack.append(allocator, .{ .id = targets[i], .expanded = false });
                }
            },
            .ret, .abort => {},
        }
    }

    // Reverse for RPO
    std.mem.reverse(BlockId, order.items);
    return order.items;
}

// ── Loop Detection ────────────────────────────────────────────────────

pub const LoopInfo = struct {
    /// Set of block IDs that are loop headers (targets of back edges)
    loop_headers: []const BlockId,
    /// For each block, whether it's a loop header
    is_loop_header: []const bool,
};

pub fn detectLoops(allocator: Allocator, cfg: *const Cfg, dom: *const DominatorTree) !LoopInfo {
    const n = cfg.blocks.len;
    const is_header = try allocator.alloc(bool, n);
    @memset(is_header, false);

    var headers = std.ArrayList(BlockId){};

    // A back edge is an edge B → H where H dominates B
    for (cfg.blocks) |block| {
        const successors = switch (block.terminator) {
            .jump => |t| &[_]BlockId{t},
            .branch => |br| &[_]BlockId{ br.then_id, br.else_id },
            .ret, .abort => &[_]BlockId{},
            .variant_switch => |targets| targets,
        };
        for (successors) |succ| {
            if (dom.dominates(succ, block.id)) {
                if (!is_header[succ]) {
                    is_header[succ] = true;
                    try headers.append(allocator, succ);
                }
            }
        }
    }

    return .{ .loop_headers = headers.items, .is_loop_header = is_header };
}

// ── Tests ─────────────────────────────────────────────────────────────

const testing = std.testing;
const binary = @import("binary.zig");

fn loadTestFile(comptime path: []const u8) []const u8 {
    return @embedFile(path);
}

test "CFG: coin::total_supply has 1 block" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = loadTestFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    // Find total_supply
    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        if (std.mem.eql(u8, module.identifiers[fh.name], "total_supply")) {
            const cfg = try buildCfg(alloc, fd.code.?.code, fd.code.?.jump_tables);
            try testing.expectEqual(@as(usize, 1), cfg.blocks.len);
            try testing.expectEqual(Terminator.ret, cfg.blocks[0].terminator);
            return;
        }
    }
    try testing.expect(false); // total_supply not found
}

test "CFG: coin::divide_into_n has loops" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = loadTestFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        if (std.mem.eql(u8, module.identifiers[fh.name], "divide_into_n")) {
            const cfg = try buildCfg(alloc, fd.code.?.code, fd.code.?.jump_tables);
            try testing.expect(cfg.blocks.len > 3);

            const dom = try computeDominators(alloc, &cfg);
            const loops = try detectLoops(alloc, &cfg, &dom);
            try testing.expect(loops.loop_headers.len > 0);
            return;
        }
    }
    try testing.expect(false);
}

test "Dominators: entry dominates all blocks" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = loadTestFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    for (module.function_defs) |fd| {
        if (fd.code) |code_unit| {
            if (code_unit.code.len > 5) {
                const cfg = try buildCfg(alloc, code_unit.code, code_unit.jump_tables);
                const dom = try computeDominators(alloc, &cfg);
                // Entry should dominate all blocks
                for (cfg.blocks) |block| {
                    try testing.expect(dom.dominates(cfg.entry, block.id));
                }
                return;
            }
        }
    }
}
