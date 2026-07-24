const std = @import("std");
const types = @import("types.zig");
const Allocator = std.mem.Allocator;
const Writer = std.ArrayList(u8);

/// Set of locals that have been declared with `let`. Shared across
/// all blocks in a function so subsequent stores become assignments.
pub const AssignedSet = std.AutoHashMap(u8, void);

/// Simulate the stack machine for a range of bytecode instructions and
/// produce readable Move-like expression strings, one per statement.
pub fn renderBlock(
    allocator: Allocator,
    module: *const types.CompiledModule,
    code: []const types.Bytecode,
    start: u16,
    end: u16,
    param_count: u16,
) ![]const []const u8 {
    var owned_assigned = AssignedSet.init(allocator);
    return renderBlockWithAssigned(allocator, module, code, start, end, param_count, &owned_assigned);
}

/// Like renderBlock but uses a shared assigned set for tracking let bindings.
pub fn renderBlockWithAssigned(
    allocator: Allocator,
    module: *const types.CompiledModule,
    code: []const types.Bytecode,
    start: u16,
    end: u16,
    param_count: u16,
    assigned: *AssignedSet,
) ![]const []const u8 {
    var stack = std.ArrayList([]const u8){};
    var statements = std.ArrayList([]const u8){};

    var i: u16 = start;
    while (i < end) : (i += 1) {
        const instr = code[i];
        switch (instr) {
            // ── Load / Push ──────────────────────────────────────
            .copy_loc => |idx| try stack.append(allocator, try localName(allocator, idx, param_count)),
            .move_loc => |idx| try stack.append(allocator, try localName(allocator, idx, param_count)),
            .imm_borrow_loc => |idx| try stack.append(allocator, try fmt(allocator, "&{s}", .{try localName(allocator, idx, param_count)})),
            .mut_borrow_loc => |idx| try stack.append(allocator, try fmt(allocator, "&mut {s}", .{try localName(allocator, idx, param_count)})),

            .ld_true => try stack.append(allocator, "true"),
            .ld_false => try stack.append(allocator, "false"),
            .ld_u8 => |v| try stack.append(allocator, try fmt(allocator, "{}u8", .{v})),
            .ld_u16 => |v| try stack.append(allocator, try fmt(allocator, "{}u16", .{v})),
            .ld_u32 => |v| try stack.append(allocator, try fmt(allocator, "{}u32", .{v})),
            .ld_u64 => |v| try stack.append(allocator, try fmt(allocator, "{}", .{v})),
            .ld_u128 => |v| try stack.append(allocator, try fmt(allocator, "{}u128", .{v})),
            .ld_u256 => |v| try stack.append(allocator, try fmt(allocator, "{}u256", .{v})),
            .ld_const => |idx| try stack.append(allocator, try renderConstant(allocator, module, idx)),

            // ── Store ────────────────────────────────────────────
            .st_loc => |idx| {
                const val = pop(&stack);
                const name = try localName(allocator, idx, param_count);
                if (assigned.get(idx) == null) {
                    try assigned.put(idx, {});
                    try statements.append(allocator, try fmt(allocator, "let {s} = {s}", .{ name, val }));
                } else {
                    try statements.append(allocator, try fmt(allocator, "{s} = {s}", .{ name, val }));
                }
            },

            // ── Field access ─────────────────────────────────────
            .imm_borrow_field => |idx| {
                const obj = pop(&stack);
                try stack.append(allocator, try fmt(allocator, "&{s}.{s}", .{ obj, fieldName(module, idx) }));
            },
            .imm_borrow_field_generic => |idx| {
                const obj = pop(&stack);
                try stack.append(allocator, try fmt(allocator, "&{s}.{s}", .{ obj, fieldInstName(module, idx) }));
            },
            .mut_borrow_field => |idx| {
                const obj = pop(&stack);
                try stack.append(allocator, try fmt(allocator, "&mut {s}.{s}", .{ obj, fieldName(module, idx) }));
            },
            .mut_borrow_field_generic => |idx| {
                const obj = pop(&stack);
                try stack.append(allocator, try fmt(allocator, "&mut {s}.{s}", .{ obj, fieldInstName(module, idx) }));
            },

            // ── Function calls ───────────────────────────────────
            .call => |idx| try renderCall(allocator, module, &stack, &statements, idx, false),
            .call_generic => |idx| try renderCallGeneric(allocator, module, &stack, &statements, idx),

            // ── Pack / Unpack ────────────────────────────────────
            .pack => |idx| try renderPack(allocator, module, &stack, idx, false),
            .pack_generic => |idx| try renderPack(allocator, module, &stack, idx, true),
            .unpack => |idx| try renderUnpack(allocator, module, &stack, &statements, idx, false, param_count),
            .unpack_generic => |idx| try renderUnpack(allocator, module, &stack, &statements, idx, true, param_count),

            // ── Refs ─────────────────────────────────────────────
            .read_ref => {
                const r = pop(&stack);
                // Cancel *&expr → expr and *&mut expr → expr
                if (std.mem.startsWith(u8, r, "&mut ")) {
                    try stack.append(allocator, r[5..]);
                } else if (r.len > 0 and r[0] == '&') {
                    try stack.append(allocator, r[1..]);
                } else {
                    try stack.append(allocator, try fmt(allocator, "*{s}", .{r}));
                }
            },
            .write_ref => {
                const val = pop(&stack);
                const r = pop(&stack);
                try statements.append(allocator, try fmt(allocator, "*{s} = {s}", .{ r, val }));
            },
            .freeze_ref => {
                const r = pop(&stack);
                try stack.append(allocator, try fmt(allocator, "freeze({s})", .{r}));
            },

            // ── Arithmetic / Logic ───────────────────────────────
            .add => try binOp(allocator, &stack, "+"),
            .sub => try binOp(allocator, &stack, "-"),
            .mul => try binOp(allocator, &stack, "*"),
            .div => try binOp(allocator, &stack, "/"),
            .mod => try binOp(allocator, &stack, "%"),
            .bit_or => try binOp(allocator, &stack, "|"),
            .bit_and => try binOp(allocator, &stack, "&"),
            .xor => try binOp(allocator, &stack, "^"),
            .shl => try binOp(allocator, &stack, "<<"),
            .shr => try binOp(allocator, &stack, ">>"),
            .@"or" => try binOp(allocator, &stack, "||"),
            .@"and" => try binOp(allocator, &stack, "&&"),
            .eq => try binOp(allocator, &stack, "=="),
            .neq => try binOp(allocator, &stack, "!="),
            .lt => try binOp(allocator, &stack, "<"),
            .gt => try binOp(allocator, &stack, ">"),
            .le => try binOp(allocator, &stack, "<="),
            .ge => try binOp(allocator, &stack, ">="),
            .not => {
                const v = pop(&stack);
                try stack.append(allocator, try fmt(allocator, "!{s}", .{v}));
            },

            // ── Cast ─────────────────────────────────────────────
            .cast_u8 => { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "({s} as u8)", .{v})); },
            .cast_u16 => { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "({s} as u16)", .{v})); },
            .cast_u32 => { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "({s} as u32)", .{v})); },
            .cast_u64 => { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "({s} as u64)", .{v})); },
            .cast_u128 => { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "({s} as u128)", .{v})); },
            .cast_u256 => { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "({s} as u256)", .{v})); },

            // ── Vector ops ───────────────────────────────────────
            .vec_len => |_| { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "vector::length(&{s})", .{v})); },
            .vec_imm_borrow => |_| { const idx_v = pop(&stack); const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "&{s}[{s}]", .{ v, idx_v })); },
            .vec_mut_borrow => |_| { const idx_v = pop(&stack); const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "&mut {s}[{s}]", .{ v, idx_v })); },
            .vec_push_back => |_| { const val = pop(&stack); const v = pop(&stack); try statements.append(allocator, try fmt(allocator, "vector::push_back(&mut {s}, {s})", .{ v, val })); },
            .vec_pop_back => |_| { const v = pop(&stack); try stack.append(allocator, try fmt(allocator, "vector::pop_back(&mut {s})", .{v})); },
            .vec_swap => |_| { const j = pop(&stack); const idx_v = pop(&stack); const v = pop(&stack); try statements.append(allocator, try fmt(allocator, "vector::swap(&mut {s}, {s}, {s})", .{ v, idx_v, j })); },
            .vec_pack => |vp| {
                var args_buf = std.ArrayList(u8){};
                var n: u64 = vp.len;
                while (n > 0) : (n -= 1) {
                    if (args_buf.items.len > 0) try args_buf.appendSlice(allocator, ", ");
                    try args_buf.appendSlice(allocator, pop(&stack));
                }
                try stack.append(allocator, try fmt(allocator, "vector[{s}]", .{args_buf.items}));
            },
            .vec_unpack => |_| {
                // Push a placeholder — unpack usually followed by st_loc
                try stack.append(allocator, "/* vec_unpack */");
            },

            // ── Control flow (handled by structuring, just emit for safety) ──
            .ret => {
                if (stack.items.len > 0) {
                    var ret_vals = std.ArrayList(u8){};
                    while (stack.items.len > 0) {
                        if (ret_vals.items.len > 0) try ret_vals.appendSlice(allocator, ", ");
                        try ret_vals.appendSlice(allocator, pop(&stack));
                    }
                    if (ret_vals.items.len > 0) {
                        try statements.append(allocator, try fmt(allocator, "{s}", .{ret_vals.items}));
                    }
                }
            },
            .abort => {
                const v = pop(&stack);
                try statements.append(allocator, try fmt(allocator, "abort {s}", .{v}));
            },
            .pop => {
                const v = pop(&stack);
                try statements.append(allocator, try fmt(allocator, "_ = {s}", .{v}));
            },
            .nop => {},

            // Branch instructions are handled structurally — leave condition on stack
            .br_true, .br_false, .branch => {},

            // ── Enum ops ─────────────────────────────────────────
            .pack_variant => |vh_idx| try renderPackVariant(allocator, module, &stack, vh_idx, false),
            .pack_variant_generic => |vi_idx| try renderPackVariant(allocator, module, &stack, vi_idx, true),
            .unpack_variant => |vh_idx| try renderUnpackVariant(allocator, module, &stack, &statements, vh_idx, false),
            .unpack_variant_imm_ref => |vh_idx| try renderUnpackVariant(allocator, module, &stack, &statements, vh_idx, false),
            .unpack_variant_mut_ref => |vh_idx| try renderUnpackVariant(allocator, module, &stack, &statements, vh_idx, false),
            .unpack_variant_generic => |vi_idx| try renderUnpackVariant(allocator, module, &stack, &statements, vi_idx, true),
            .unpack_variant_generic_imm_ref => |vi_idx| try renderUnpackVariant(allocator, module, &stack, &statements, vi_idx, true),
            .unpack_variant_generic_mut_ref => |vi_idx| try renderUnpackVariant(allocator, module, &stack, &statements, vi_idx, true),
            .variant_switch => {},

            // Deprecated global ops
            .exists_deprecated, .exists_generic_deprecated => try stack.append(allocator, "/* exists */"),
            .mut_borrow_global_deprecated, .mut_borrow_global_generic_deprecated => try stack.append(allocator, "/* borrow_global_mut */"),
            .imm_borrow_global_deprecated, .imm_borrow_global_generic_deprecated => try stack.append(allocator, "/* borrow_global */"),
            .move_from_deprecated, .move_from_generic_deprecated => try stack.append(allocator, "/* move_from */"),
            .move_to_deprecated, .move_to_generic_deprecated => { _ = pop(&stack); try statements.append(allocator, "/* move_to */"); },
        }
    }

    // Anything remaining on stack at end of block is an implicit expression
    while (stack.items.len > 0) {
        try statements.append(allocator, pop(&stack));
    }

    return statements.items;
}

// ── Helpers ───────────────────────────────────────────────────────────

fn pop(stack: *std.ArrayList([]const u8)) []const u8 {
    return stack.pop() orelse "???";
}

fn localName(allocator: Allocator, idx: u8, param_count: u16) ![]const u8 {
    if (idx < param_count)
        return fmt(allocator, "arg{}", .{idx})
    else
        return fmt(allocator, "v{}", .{idx});
}

fn binOp(allocator: Allocator, stack: *std.ArrayList([]const u8), op: []const u8) !void {
    const rhs = pop(stack);
    const lhs = pop(stack);
    try stack.append(allocator, try fmt(allocator, "({s} {s} {s})", .{ lhs, op, rhs }));
}

fn fieldName(module: *const types.CompiledModule, idx: types.FieldHandleIndex) []const u8 {
    if (idx >= module.field_handles.len) return "?field";
    const fh = module.field_handles[idx];
    if (fh.owner >= module.struct_defs.len) return "?field";
    const sd = module.struct_defs[fh.owner];
    switch (sd.field_info) {
        .declared => |fields| {
            if (fh.field < fields.len)
                return module.identifiers[fields[fh.field].name];
        },
        .native => {},
    }
    return "?field";
}

fn fieldInstName(module: *const types.CompiledModule, idx: types.FieldInstIndex) []const u8 {
    if (idx >= module.field_instantiations.len) return "?field";
    return fieldName(module, module.field_instantiations[idx].handle);
}

fn resolveFuncName(allocator: Allocator, module: *const types.CompiledModule, fh_idx: types.FunctionHandleIndex) ![]const u8 {
    const fh = module.function_handles[fh_idx];
    const mh = module.module_handles[fh.module];
    const fn_name = module.identifiers[fh.name];

    if (fh.module == module.self_module_handle_idx) {
        return fn_name;
    }

    const mod_name = module.identifiers[mh.name];
    return fmt(allocator, "{s}::{s}", .{ mod_name, fn_name });
}

fn renderCall(
    allocator: Allocator,
    module: *const types.CompiledModule,
    stack: *std.ArrayList([]const u8),
    statements: *std.ArrayList([]const u8),
    fh_idx: types.FunctionHandleIndex,
    _: bool,
) !void {
    const fh = module.function_handles[fh_idx];
    const fn_name = try resolveFuncName(allocator, module, fh_idx);
    const param_sig = module.signatures[fh.parameters];
    const ret_sig = module.signatures[fh.return_];

    // Pop arguments (in reverse)
    const arg_count = param_sig.tokens.len;
    const args = try allocator.alloc([]const u8, arg_count);
    var j: usize = arg_count;
    while (j > 0) {
        j -= 1;
        args[j] = pop(stack);
    }

    var call_buf = std.ArrayList(u8){};
    try call_buf.appendSlice(allocator, fn_name);
    try call_buf.append(allocator, '(');
    for (args, 0..) |arg, idx| {
        if (idx > 0) try call_buf.appendSlice(allocator, ", ");
        try call_buf.appendSlice(allocator, arg);
    }
    try call_buf.append(allocator, ')');

    if (ret_sig.tokens.len == 0) {
        try statements.append(allocator, call_buf.items);
    } else if (ret_sig.tokens.len == 1) {
        try stack.append(allocator, call_buf.items);
    } else {
        // Multi-return: push each return value with tuple index
        // The call itself becomes a let binding
        const call_str = try allocator.dupe(u8, call_buf.items);
        for (0..ret_sig.tokens.len) |ri| {
            try stack.append(allocator, try fmt(allocator, "{s}.{}", .{ call_str, ri }));
        }
    }
}

fn renderCallGeneric(
    allocator: Allocator,
    module: *const types.CompiledModule,
    stack: *std.ArrayList([]const u8),
    statements: *std.ArrayList([]const u8),
    fi_idx: types.FunctionInstIndex,
) !void {
    if (fi_idx >= module.function_instantiations.len) {
        try stack.append(allocator, "/* call_generic? */");
        return;
    }
    const fi = module.function_instantiations[fi_idx];
    try renderCall(allocator, module, stack, statements, fi.handle, true);
}

fn renderPack(
    allocator: Allocator,
    module: *const types.CompiledModule,
    stack: *std.ArrayList([]const u8),
    sd_idx: u16,
    is_generic: bool,
) !void {
    const actual_idx = if (is_generic and sd_idx < module.struct_def_instantiations.len)
        module.struct_def_instantiations[sd_idx].def
    else
        sd_idx;

    if (actual_idx >= module.struct_defs.len) {
        try stack.append(allocator, "/* pack? */");
        return;
    }
    const sd = module.struct_defs[actual_idx];
    const dh = module.datatype_handles[sd.struct_handle];
    const name = module.identifiers[dh.name];

    switch (sd.field_info) {
        .declared => |fields| {
            var buf = std.ArrayList(u8){};
            try buf.appendSlice(allocator, name);
            try buf.appendSlice(allocator, " { ");
            var fi: usize = fields.len;
            while (fi > 0) {
                fi -= 1;
                if (fi < fields.len - 1) try buf.appendSlice(allocator, ", ");
                try buf.appendSlice(allocator, module.identifiers[fields[fi].name]);
                try buf.appendSlice(allocator, ": ");
                try buf.appendSlice(allocator, pop(stack));
            }
            try buf.appendSlice(allocator, " }");
            try stack.append(allocator, buf.items);
        },
        .native => try stack.append(allocator, name),
    }
}

fn renderUnpack(
    allocator: Allocator,
    module: *const types.CompiledModule,
    stack: *std.ArrayList([]const u8),
    statements: *std.ArrayList([]const u8),
    sd_idx: u16,
    is_generic: bool,
    param_count: u16,
) !void {
    _ = param_count;
    const actual_idx = if (is_generic and sd_idx < module.struct_def_instantiations.len)
        module.struct_def_instantiations[sd_idx].def
    else
        sd_idx;

    if (actual_idx >= module.struct_defs.len) {
        try statements.append(allocator, "/* unpack? */");
        return;
    }
    const sd = module.struct_defs[actual_idx];
    const dh = module.datatype_handles[sd.struct_handle];
    const name = module.identifiers[dh.name];
    const val = pop(stack);

    switch (sd.field_info) {
        .declared => |fields| {
            var buf = std.ArrayList(u8){};
            try buf.appendSlice(allocator, "let ");
            try buf.appendSlice(allocator, name);
            try buf.appendSlice(allocator, " { ");
            for (fields, 0..) |field, fi| {
                if (fi > 0) try buf.appendSlice(allocator, ", ");
                try buf.appendSlice(allocator, module.identifiers[field.name]);
            }
            try buf.appendSlice(allocator, " } = ");
            try buf.appendSlice(allocator, val);
            try statements.append(allocator, buf.items);

            // Push each field onto the stack (in order)
            for (fields) |field| {
                try stack.append(allocator, module.identifiers[field.name]);
            }
        },
        .native => try statements.append(allocator, try fmt(allocator, "let _ = {s} /* native unpack {s} */", .{ val, name })),
    }
}

fn resolveVariant(module: *const types.CompiledModule, idx: u16, is_generic: bool) ?struct { enum_name: []const u8, variant_name: []const u8, fields: []const types.FieldDefinition } {
    if (is_generic) {
        if (idx >= module.variant_inst_handles.len) return null;
        const vi = module.variant_inst_handles[idx];
        if (vi.enum_def_inst >= module.enum_def_instantiations.len) return null;
        const edi = module.enum_def_instantiations[vi.enum_def_inst];
        if (edi.def >= module.enum_defs.len) return null;
        const ed = module.enum_defs[edi.def];
        const dh = module.datatype_handles[ed.enum_handle];
        if (vi.variant >= ed.variants.len) return null;
        const vd = ed.variants[vi.variant];
        return .{ .enum_name = module.identifiers[dh.name], .variant_name = module.identifiers[vd.name], .fields = vd.fields };
    } else {
        if (idx >= module.variant_handles.len) return null;
        const vh = module.variant_handles[idx];
        if (vh.enum_def >= module.enum_defs.len) return null;
        const ed = module.enum_defs[vh.enum_def];
        const dh = module.datatype_handles[ed.enum_handle];
        if (vh.variant >= ed.variants.len) return null;
        const vd = ed.variants[vh.variant];
        return .{ .enum_name = module.identifiers[dh.name], .variant_name = module.identifiers[vd.name], .fields = vd.fields };
    }
}

fn renderPackVariant(
    allocator: Allocator,
    module: *const types.CompiledModule,
    stack: *std.ArrayList([]const u8),
    idx: u16,
    is_generic: bool,
) !void {
    const info = resolveVariant(module, idx, is_generic) orelse {
        try stack.append(allocator, "/* variant_pack? */");
        return;
    };

    var buf = std.ArrayList(u8){};
    try buf.appendSlice(allocator, info.enum_name);
    try buf.appendSlice(allocator, "::");
    try buf.appendSlice(allocator, info.variant_name);

    if (info.fields.len > 0) {
        try buf.appendSlice(allocator, " { ");
        var fi: usize = info.fields.len;
        while (fi > 0) {
            fi -= 1;
            if (fi < info.fields.len - 1) try buf.appendSlice(allocator, ", ");
            try buf.appendSlice(allocator, module.identifiers[info.fields[fi].name]);
            try buf.appendSlice(allocator, ": ");
            try buf.appendSlice(allocator, pop(stack));
        }
        try buf.appendSlice(allocator, " }");
    }

    try stack.append(allocator, buf.items);
}

fn renderUnpackVariant(
    allocator: Allocator,
    module: *const types.CompiledModule,
    stack: *std.ArrayList([]const u8),
    statements: *std.ArrayList([]const u8),
    idx: u16,
    is_generic: bool,
) !void {
    const info = resolveVariant(module, idx, is_generic) orelse {
        try statements.append(allocator, "/* variant_unpack? */");
        return;
    };

    const val = pop(stack);

    var buf = std.ArrayList(u8){};
    try buf.appendSlice(allocator, "let ");
    try buf.appendSlice(allocator, info.enum_name);
    try buf.appendSlice(allocator, "::");
    try buf.appendSlice(allocator, info.variant_name);

    if (info.fields.len > 0) {
        try buf.appendSlice(allocator, " { ");
        for (info.fields, 0..) |field, fi| {
            if (fi > 0) try buf.appendSlice(allocator, ", ");
            try buf.appendSlice(allocator, module.identifiers[field.name]);
        }
        try buf.appendSlice(allocator, " }");
    }

    try buf.appendSlice(allocator, " = ");
    try buf.appendSlice(allocator, val);
    try statements.append(allocator, buf.items);

    // Push each field onto the stack
    for (info.fields) |field| {
        try stack.append(allocator, module.identifiers[field.name]);
    }
}

fn renderConstant(allocator: Allocator, module: *const types.CompiledModule, idx: types.ConstantPoolIndex) ![]const u8 {
    if (idx >= module.constant_pool.len) return "/* const? */";
    const c = module.constant_pool[idx];
    const data = c.data;

    // Try to render based on type
    switch (c.type_.*) {
        .bool => return if (data.len > 0 and data[0] != 0) "true" else "false",
        .u8 => return if (data.len >= 1) fmt(allocator, "{}u8", .{data[0]}) else "0u8",
        .u16 => {
            if (data.len >= 2) {
                var val: u16 = 0;
                for (0..2) |j| val |= @as(u16, data[j]) << @intCast(j * 8);
                return fmt(allocator, "{}u16", .{val});
            }
            return "0u16";
        },
        .u32 => {
            if (data.len >= 4) {
                var val: u32 = 0;
                for (0..4) |j| val |= @as(u32, data[j]) << @intCast(j * 8);
                return fmt(allocator, "{}u32", .{val});
            }
            return "0u32";
        },
        .u64 => {
            if (data.len >= 8) {
                var val: u64 = 0;
                for (0..8) |j| val |= @as(u64, data[j]) << @intCast(j * 8);
                return fmt(allocator, "{}", .{val});
            }
            return "0";
        },
        .u128 => {
            if (data.len >= 16) {
                var val: u128 = 0;
                for (0..16) |j| val |= @as(u128, data[j]) << @intCast(j * 8);
                return fmt(allocator, "{}u128", .{val});
            }
            return "0u128";
        },
        .u256 => {
            if (data.len >= 32) {
                var val: u256 = 0;
                for (0..32) |j| val |= @as(u256, data[j]) << @intCast(j * 8);
                return fmt(allocator, "{}u256", .{val});
            }
            return "0u256";
        },
        .address => {
            if (data.len >= 32) {
                var start: usize = 0;
                while (start < 31 and data[start] == 0) start += 1;
                var buf = std.ArrayList(u8){};
                try buf.appendSlice(allocator, "@0x");
                const hex = "0123456789abcdef";
                for (data[start..@min(data.len, 32)]) |b| {
                    try buf.append(allocator, hex[b >> 4]);
                    try buf.append(allocator, hex[b & 0xf]);
                }
                return buf.items;
            }
            return "@0x0";
        },
        .vector => |inner| {
            if (inner.* == .u8 and data.len > 0) {
                // Try as UTF-8 string
                const str_len = data[0]; // ULEB128 length (first byte for short strings)
                if (str_len + 1 <= data.len) {
                    const str_data = data[1..@min(data.len, str_len + 1)];
                    var is_printable = true;
                    for (str_data) |b| {
                        if (b < 0x20 or b > 0x7e) {
                            is_printable = false;
                            break;
                        }
                    }
                    if (is_printable and str_data.len > 0) {
                        return fmt(allocator, "b\"{s}\"", .{str_data});
                    }
                }
                // Hex bytes
                var buf = std.ArrayList(u8){};
                try buf.appendSlice(allocator, "x\"");
                const hex = "0123456789abcdef";
                const bytes_to_show = @min(data.len, 16);
                for (data[0..bytes_to_show]) |b| {
                    try buf.append(allocator, hex[b >> 4]);
                    try buf.append(allocator, hex[b & 0xf]);
                }
                if (data.len > 16) try buf.appendSlice(allocator, "...");
                try buf.append(allocator, '"');
                return buf.items;
            }
            return "/* const_vec */";
        },
        .signer => return "/* signer_const */",
        else => return "/* const */",
    }
}

fn fmt(allocator: Allocator, comptime format: []const u8, args: anytype) ![]const u8 {
    return std.fmt.allocPrint(allocator, format, args);
}

// ── Tests ─────────────────────────────────────────────────────────────

const testing = std.testing;
const binary = @import("binary.zig");

test "expr: render total_supply body" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = @embedFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    // Find total_supply
    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        if (std.mem.eql(u8, module.identifiers[fh.name], "total_supply")) {
            const param_sig = module.signatures[fh.parameters];
            const stmts = try renderBlock(alloc, &module, fd.code.?.code, 0, @intCast(fd.code.?.code.len), @intCast(param_sig.tokens.len));
            try testing.expect(stmts.len > 0);
            // Should contain a function call to balance::value or similar
            var has_call = false;
            for (stmts) |s| {
                if (std.mem.indexOf(u8, s, "(") != null) has_call = true;
            }
            try testing.expect(has_call);
            return;
        }
    }
}
