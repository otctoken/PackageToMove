const std = @import("std");
const types = @import("types.zig");
const cfg_mod = @import("cfg.zig");
const ast = @import("ast.zig");
const expr = @import("expr.zig");
const Allocator = std.mem.Allocator;

const Writer = std.ArrayList(u8);

pub fn printModule(allocator: Allocator, module: *const types.CompiledModule) ![]u8 {
    var out: Writer = .{};

    const self_handle = module.module_handles[module.self_module_handle_idx];
    const mod_name = module.identifiers[self_handle.name];
    const mod_addr = module.address_identifiers[self_handle.address];

    try out.appendSlice(allocator, "module ");
    try writeAddress(&out, allocator, &mod_addr);
    try out.appendSlice(allocator, "::");
    try out.appendSlice(allocator, mod_name);
    try out.appendSlice(allocator, " {\n");

    // Structs
    for (module.struct_defs) |sd| {
        try out.append(allocator, '\n');
        try printStruct(&out, allocator, module, &sd);
    }

    // Enums
    for (module.enum_defs) |ed| {
        try out.append(allocator, '\n');
        try printEnum(&out, allocator, module, &ed);
    }

    // Functions
    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        // Skip functions from other modules
        if (fh.module != module.self_module_handle_idx) continue;

        try out.append(allocator, '\n');
        try printFunction(&out, allocator, module, &fd, null, null, null);
    }

    try out.appendSlice(allocator, "\n}\n");
    return out.items;
}

/// Print a module with structured function bodies
pub fn printModuleStructured(
    allocator: Allocator,
    module: *const types.CompiledModule,
    cfgs: []const cfg_mod.Cfg,
    doms: []const cfg_mod.DominatorTree,
    loop_infos: []const cfg_mod.LoopInfo,
    structured: []const *const ast.Node,
) ![]u8 {
    var out: Writer = .{};

    const self_handle = module.module_handles[module.self_module_handle_idx];
    const mod_name = module.identifiers[self_handle.name];
    const mod_addr = module.address_identifiers[self_handle.address];

    try out.appendSlice(allocator, "module ");
    try writeAddress(&out, allocator, &mod_addr);
    try out.appendSlice(allocator, "::");
    try out.appendSlice(allocator, mod_name);
    try out.appendSlice(allocator, " {\n");

    // Use declarations for external modules
    try writeUseDecls(&out, allocator, module);

    // Structs
    for (module.struct_defs) |sd| {
        try out.append(allocator, '\n');
        try printStruct(&out, allocator, module, &sd);
    }

    // Functions with structured bodies
    var func_idx: usize = 0;
    for (module.function_defs) |fd| {
        const fh = module.function_handles[fd.function];
        if (fh.module != module.self_module_handle_idx) continue;

        try out.append(allocator, '\n');
        if (fd.code != null and func_idx < structured.len) {
            try printFunction(&out, allocator, module, &fd, &cfgs[func_idx], structured[func_idx], null);
            func_idx += 1;
        } else {
            try printFunction(&out, allocator, module, &fd, null, null, null);
        }
    }
    _ = doms;
    _ = loop_infos;

    try out.appendSlice(allocator, "\n}\n");
    return out.items;
}

fn printStruct(out: *Writer, allocator: Allocator, module: *const types.CompiledModule, sd: *const types.StructDefinition) !void {
    const dh = module.datatype_handles[sd.struct_handle];
    const name = module.identifiers[dh.name];

    try out.appendSlice(allocator, "    struct ");
    try out.appendSlice(allocator, name);
    try writeTypeParams(out, allocator, dh.type_parameters);
    try writeAbilities(out, allocator, dh.abilities);

    switch (sd.field_info) {
        .native => try out.appendSlice(allocator, " has native;\n"),
        .declared => |fields| {
            try out.appendSlice(allocator, " {\n");
            for (fields) |field| {
                try out.appendSlice(allocator, "        ");
                try out.appendSlice(allocator, module.identifiers[field.name]);
                try out.appendSlice(allocator, ": ");
                try writeSignatureToken(out, allocator, module, field.signature);
                try out.appendSlice(allocator, ",\n");
            }
            try out.appendSlice(allocator, "    }\n");
        },
    }
}

fn printEnum(out: *Writer, allocator: Allocator, module: *const types.CompiledModule, ed: *const types.EnumDefinition) !void {
    const dh = module.datatype_handles[ed.enum_handle];
    const name = module.identifiers[dh.name];

    try out.appendSlice(allocator, "    enum ");
    try out.appendSlice(allocator, name);
    try writeTypeParams(out, allocator, dh.type_parameters);
    try writeAbilities(out, allocator, dh.abilities);
    try out.appendSlice(allocator, " {\n");

    for (ed.variants) |variant| {
        try out.appendSlice(allocator, "        ");
        try out.appendSlice(allocator, module.identifiers[variant.name]);
        if (variant.fields.len > 0) {
            try out.appendSlice(allocator, " { ");
            for (variant.fields, 0..) |field, i| {
                if (i > 0) try out.appendSlice(allocator, ", ");
                try out.appendSlice(allocator, module.identifiers[field.name]);
                try out.appendSlice(allocator, ": ");
                try writeSignatureToken(out, allocator, module, field.signature);
            }
            try out.appendSlice(allocator, " }");
        }
        try out.appendSlice(allocator, ",\n");
    }
    try out.appendSlice(allocator, "    }\n");
}

fn printFunction(
    out: *Writer,
    allocator: Allocator,
    module: *const types.CompiledModule,
    fd: *const types.FunctionDefinition,
    cfg_opt: ?*const cfg_mod.Cfg,
    structured_opt: ?*const ast.Node,
    _: ?*const cfg_mod.DominatorTree,
) !void {
    const fh = module.function_handles[fd.function];
    const name = module.identifiers[fh.name];

    try out.appendSlice(allocator, "    ");
    switch (fd.visibility) {
        .public => try out.appendSlice(allocator, "public "),
        .friend => try out.appendSlice(allocator, "public(friend) "),
        .private => {},
        .deprecated_script => try out.appendSlice(allocator, "/* script */ "),
    }
    if (fd.is_entry) try out.appendSlice(allocator, "entry ");
    if (fd.is_native) try out.appendSlice(allocator, "native ");
    try out.appendSlice(allocator, "fun ");
    try out.appendSlice(allocator, name);

    // Type parameters
    if (fh.type_parameters.len > 0) {
        try out.append(allocator, '<');
        for (fh.type_parameters, 0..) |_, i| {
            if (i > 0) try out.appendSlice(allocator, ", ");
            try out.append(allocator, 'T');
            try writeUsize(out, allocator, i);
        }
        try out.append(allocator, '>');
    }

    // Parameters
    try out.append(allocator, '(');
    const param_sig = module.signatures[fh.parameters];
    for (param_sig.tokens, 0..) |token, i| {
        if (i > 0) try out.appendSlice(allocator, ", ");
        try out.appendSlice(allocator, "arg");
        try writeUsize(out, allocator, i);
        try out.appendSlice(allocator, ": ");
        try writeSignatureToken(out, allocator, module, token);
    }
    try out.append(allocator, ')');

    // Return type
    const ret_sig = module.signatures[fh.return_];
    if (ret_sig.tokens.len > 0) {
        try out.appendSlice(allocator, ": ");
        if (ret_sig.tokens.len == 1) {
            try writeSignatureToken(out, allocator, module, ret_sig.tokens[0]);
        } else {
            try out.append(allocator, '(');
            for (ret_sig.tokens, 0..) |token, i| {
                if (i > 0) try out.appendSlice(allocator, ", ");
                try writeSignatureToken(out, allocator, module, token);
            }
            try out.append(allocator, ')');
        }
    }

    if (fd.is_native) {
        try out.appendSlice(allocator, ";\n");
        return;
    }

    try out.appendSlice(allocator, " {\n");

    if (structured_opt) |node| {
        const param_count: u16 = @intCast(param_sig.tokens.len);
        const has_return = module.signatures[module.function_handles[fd.function].return_].tokens.len > 0;
        var assigned = expr.AssignedSet.init(allocator);
        try printNode(out, allocator, module, cfg_opt.?, fd.code.?.code, param_count, node, 2, &assigned, has_return);
    } else if (fd.code) |code_unit| {
        // Fallback: print raw bytecode
        for (code_unit.code, 0..) |instr, i| {
            try out.appendSlice(allocator, "        // ");
            try writeUsize(out, allocator, i);
            try out.appendSlice(allocator, ": ");
            try writeBytecodeInstr(out, allocator, module, &instr);
            try out.append(allocator, '\n');
        }
    }

    try out.appendSlice(allocator, "    }\n");
}

fn printNode(
    out: *Writer,
    allocator: Allocator,
    module: *const types.CompiledModule,
    cfg: *const cfg_mod.Cfg,
    code: []const types.Bytecode,
    param_count: u16,
    node: *const ast.Node,
    indent: usize,
    assigned: *expr.AssignedSet,
    has_return: bool,
) anyerror!void {
    switch (node.*) {
        .empty => {},
        .block => |block_id| {
            const block = cfg.blocks[block_id];
            // Don't render the branch instruction (represented structurally)
            const end = switch (block.terminator) {
                .branch => if (block.end > block.start) block.end - 1 else block.end,
                else => block.end,
            };
            if (end <= block.start) return;
            const stmts = expr.renderBlockWithAssigned(allocator, module, code, block.start, end, param_count, assigned) catch return;
            for (stmts, 0..) |stmt, si| {
                try writeIndent(out, allocator, indent);
                try out.appendSlice(allocator, stmt);
                // Omit semicolon on last expression of a returning function at top-level indent
                if (has_return and indent == 2 and si == stmts.len - 1 and isLastNode(node)) {
                    try out.append(allocator, '\n');
                } else {
                    try out.appendSlice(allocator, ";\n");
                }
            }
        },
        .seq => |nodes| {
            for (nodes, 0..) |n, ni| {
                // For the last node in a seq, propagate has_return
                const is_last = ni == nodes.len - 1;
                try printNode(out, allocator, module, cfg, code, param_count, n, indent, assigned, has_return and is_last);
            }
        },
        .if_else => |ie| {
            // Render entire condition block (minus branch instruction).
            // Last expression on the stack becomes the condition; earlier statements are preamble.
            const cond_block = cfg.blocks[ie.cond_block];
            const cond_end = if (cond_block.end > cond_block.start) cond_block.end - 1 else cond_block.end;
            const all_stmts = expr.renderBlockWithAssigned(allocator, module, code, cond_block.start, cond_end, param_count, assigned) catch &.{};

            // All but last are preamble statements
            if (all_stmts.len > 1) {
                for (all_stmts[0 .. all_stmts.len - 1]) |stmt| {
                    try writeIndent(out, allocator, indent);
                    try out.appendSlice(allocator, stmt);
                    try out.appendSlice(allocator, ";\n");
                }
            }
            const cond_expr = if (all_stmts.len > 0) all_stmts[all_stmts.len - 1] else "/* cond */";

            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "if (");
            try out.appendSlice(allocator, cond_expr);
            try out.appendSlice(allocator, ") {\n");
            try printNode(out, allocator, module, cfg, code, param_count, ie.then_branch, indent + 1, assigned, false);
            if (ie.else_branch) |eb| {
                try writeIndent(out, allocator, indent);
                try out.appendSlice(allocator, "} else {\n");
                try printNode(out, allocator, module, cfg, code, param_count, eb, indent + 1, assigned, false);
            }
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "}\n");
        },
        .while_loop => |wl| {
            const cond_block = cfg.blocks[wl.cond_block];
            const cond_end = if (cond_block.end > cond_block.start) cond_block.end - 1 else cond_block.end;
            const all_stmts = expr.renderBlockWithAssigned(allocator, module, code, cond_block.start, cond_end, param_count, assigned) catch &.{};
            if (all_stmts.len > 1) {
                for (all_stmts[0 .. all_stmts.len - 1]) |stmt| {
                    try writeIndent(out, allocator, indent);
                    try out.appendSlice(allocator, stmt);
                    try out.appendSlice(allocator, ";\n");
                }
            }
            const cond_expr = if (all_stmts.len > 0) all_stmts[all_stmts.len - 1] else "true";

            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "while (");
            try out.appendSlice(allocator, cond_expr);
            try out.appendSlice(allocator, ") {\n");
            try printNodeStripTrailingContinue(out, allocator, module, cfg, code, param_count, wl.body, indent + 1, assigned);
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "}\n");
        },
        .loop_ => |lp| {
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "loop {\n");
            try printNodeStripTrailingContinue(out, allocator, module, cfg, code, param_count, lp.body, indent + 1, assigned);
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "}\n");
        },
        .match_ => |m| {
            const cond_block = cfg.blocks[m.cond_block];
            // Render preamble (everything before the variant_switch instruction)
            const cond_end = if (cond_block.end > cond_block.start) cond_block.end - 1 else cond_block.end;
            if (cond_end > cond_block.start) {
                const preamble = expr.renderBlockWithAssigned(allocator, module, code, cond_block.start, cond_end, param_count, assigned) catch &.{};
                for (preamble) |stmt| {
                    try writeIndent(out, allocator, indent);
                    try out.appendSlice(allocator, stmt);
                    try out.appendSlice(allocator, ";\n");
                }
            }

            // Resolve enum variant names from the variant_switch instruction
            const last_instr = code[cond_block.end - 1];
            var enum_def_idx: ?types.EnumDefIndex = null;
            switch (last_instr) {
                .variant_switch => |jt_idx| {
                    // Look up the function's jump table to find the enum
                    for (module.function_defs) |fd| {
                        const fh = module.function_handles[fd.function];
                        if (fh.module != module.self_module_handle_idx) continue;
                        if (fd.code) |cu| {
                            if (cu.code.ptr == code.ptr and jt_idx < cu.jump_tables.len) {
                                enum_def_idx = cu.jump_tables[jt_idx].head_enum;
                                break;
                            }
                        }
                    }
                },
                else => {},
            }

            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "match {\n");
            for (m.arms, 0..) |arm, ai| {
                try writeIndent(out, allocator, indent + 1);
                // Try to resolve variant name
                if (enum_def_idx) |eidx| {
                    if (eidx < module.enum_defs.len) {
                        const ed = module.enum_defs[eidx];
                        if (ai < ed.variants.len) {
                            const dh = module.datatype_handles[ed.enum_handle];
                            try out.appendSlice(allocator, module.identifiers[dh.name]);
                            try out.appendSlice(allocator, "::");
                            try out.appendSlice(allocator, module.identifiers[ed.variants[ai].name]);
                        } else {
                            try out.appendSlice(allocator, "_ /* variant ");
                            try writeUsize(out, allocator, ai);
                            try out.appendSlice(allocator, " */");
                        }
                    }
                } else {
                    try out.appendSlice(allocator, "_ /* variant ");
                    try writeUsize(out, allocator, ai);
                    try out.appendSlice(allocator, " */");
                }
                try out.appendSlice(allocator, " => {\n");
                try printNode(out, allocator, module, cfg, code, param_count, arm.body, indent + 2, assigned, false);
                try writeIndent(out, allocator, indent + 1);
                try out.appendSlice(allocator, "}\n");
            }
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "}\n");
        },
        .break_ => {
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "break;\n");
        },
        .continue_ => {
            // Skip — trailing continues are removed by isTrailingContinue check below
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "continue;\n");
        },
        .return_ => {
            try writeIndent(out, allocator, indent);
            try out.appendSlice(allocator, "return;\n");
        },
    }
}

/// Returns true if this node is a leaf block (for semicolon omission on return values)
fn isLastNode(node: *const ast.Node) bool {
    return node.* == .block;
}

/// Print a loop body, stripping a trailing `continue` which is always redundant.
fn printNodeStripTrailingContinue(
    out: *Writer,
    allocator: Allocator,
    module: *const types.CompiledModule,
    cfg: *const cfg_mod.Cfg,
    code: []const types.Bytecode,
    param_count: u16,
    node: *const ast.Node,
    indent: usize,
    assigned: *expr.AssignedSet,
) anyerror!void {
    switch (node.*) {
        .seq => |nodes| {
            for (nodes, 0..) |n, ni| {
                if (ni == nodes.len - 1) {
                    // Recurse to strip trailing continue from last element
                    try printNodeStripTrailingContinue(out, allocator, module, cfg, code, param_count, n, indent, assigned);
                } else {
                    try printNode(out, allocator, module, cfg, code, param_count, n, indent, assigned, false);
                }
            }
        },
        .continue_ => {}, // Trailing continue — skip
        else => try printNode(out, allocator, module, cfg, code, param_count, node, indent, assigned, false),
    }
}

// ── Helper Writers ────────────────────────────────────────────────────

fn writeUseDecls(out: *Writer, allocator: Allocator, module: *const types.CompiledModule) !void {
    var has_any = false;
    for (module.module_handles, 0..) |mh, i| {
        if (i == module.self_module_handle_idx) continue;
        if (!has_any) {
            has_any = true;
        }
        try out.appendSlice(allocator, "    use ");
        try writeAddress(out, allocator, &module.address_identifiers[mh.address]);
        try out.appendSlice(allocator, "::");
        try out.appendSlice(allocator, module.identifiers[mh.name]);
        try out.appendSlice(allocator, ";\n");
    }
    if (has_any) try out.append(allocator, '\n');
}

fn writeIndent(out: *Writer, allocator: Allocator, level: usize) !void {
    for (0..level) |_| try out.appendSlice(allocator, "    ");
}

fn writeUsize(out: *Writer, allocator: Allocator, val: usize) !void {
    var buf: [20]u8 = undefined;
    const str = std.fmt.bufPrint(&buf, "{}", .{val}) catch return;
    try out.appendSlice(allocator, str);
}

fn writeAddress(out: *Writer, allocator: Allocator, addr: *const [32]u8) !void {
    try out.appendSlice(allocator, "0x");
    // Trim leading zeros
    var start: usize = 0;
    while (start < 31 and addr[start] == 0) start += 1;
    for (addr[start..]) |b| {
        const hex = "0123456789abcdef";
        try out.append(allocator, hex[b >> 4]);
        try out.append(allocator, hex[b & 0xf]);
    }
}

fn writeTypeParams(out: *Writer, allocator: Allocator, tps: []const types.DatatypeTyParameter) !void {
    if (tps.len == 0) return;
    try out.append(allocator, '<');
    for (tps, 0..) |tp, i| {
        if (i > 0) try out.appendSlice(allocator, ", ");
        if (tp.is_phantom) try out.appendSlice(allocator, "phantom ");
        try out.append(allocator, 'T');
        try writeUsize(out, allocator, i);
    }
    try out.append(allocator, '>');
}

fn writeAbilities(out: *Writer, allocator: Allocator, abilities: types.AbilitySet) !void {
    const byte = abilities.toByte();
    if (byte == 0) return;
    try out.appendSlice(allocator, " has ");
    var first = true;
    if (abilities.copy) {
        try out.appendSlice(allocator, "copy");
        first = false;
    }
    if (abilities.drop) {
        if (!first) try out.appendSlice(allocator, " + ");
        try out.appendSlice(allocator, "drop");
        first = false;
    }
    if (abilities.store) {
        if (!first) try out.appendSlice(allocator, " + ");
        try out.appendSlice(allocator, "store");
        first = false;
    }
    if (abilities.key) {
        if (!first) try out.appendSlice(allocator, " + ");
        try out.appendSlice(allocator, "key");
    }
}

fn writeSignatureToken(out: *Writer, allocator: Allocator, module: *const types.CompiledModule, token: *const types.SignatureToken) !void {
    switch (token.*) {
        .bool => try out.appendSlice(allocator, "bool"),
        .u8 => try out.appendSlice(allocator, "u8"),
        .u16 => try out.appendSlice(allocator, "u16"),
        .u32 => try out.appendSlice(allocator, "u32"),
        .u64 => try out.appendSlice(allocator, "u64"),
        .u128 => try out.appendSlice(allocator, "u128"),
        .u256 => try out.appendSlice(allocator, "u256"),
        .address => try out.appendSlice(allocator, "address"),
        .signer => try out.appendSlice(allocator, "signer"),
        .vector => |inner| {
            try out.appendSlice(allocator, "vector<");
            try writeSignatureToken(out, allocator, module, inner);
            try out.append(allocator, '>');
        },
        .reference => |inner| {
            try out.append(allocator, '&');
            try writeSignatureToken(out, allocator, module, inner);
        },
        .mutable_reference => |inner| {
            try out.appendSlice(allocator, "&mut ");
            try writeSignatureToken(out, allocator, module, inner);
        },
        .datatype => |idx| {
            try writeDatatypeName(out, allocator, module, idx);
        },
        .datatype_instantiation => |di| {
            try writeDatatypeName(out, allocator, module, di.handle);
            try out.append(allocator, '<');
            for (di.type_arguments, 0..) |arg, i| {
                if (i > 0) try out.appendSlice(allocator, ", ");
                try writeSignatureToken(out, allocator, module, arg);
            }
            try out.append(allocator, '>');
        },
        .type_parameter => |idx| {
            try out.append(allocator, 'T');
            try writeUsize(out, allocator, idx);
        },
    }
}

fn writeDatatypeName(out: *Writer, allocator: Allocator, module: *const types.CompiledModule, idx: types.DatatypeHandleIndex) !void {
    const dh = module.datatype_handles[idx];
    const mh = module.module_handles[dh.module];

    // Only qualify with module name (not address) for external modules
    if (dh.module != module.self_module_handle_idx) {
        try out.appendSlice(allocator, module.identifiers[mh.name]);
        try out.appendSlice(allocator, "::");
    }
    try out.appendSlice(allocator, module.identifiers[dh.name]);
}

fn writeBytecodeInstr(out: *Writer, allocator: Allocator, module: *const types.CompiledModule, instr: anytype) !void {
    _ = module;
    _ = instr;
    try out.appendSlice(allocator, "...");
}

// ── Tests ─────────────────────────────────────────────────────────────

const testing = std.testing;
const binary = @import("binary.zig");

test "printer: coin module produces valid output" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = @embedFile("test_data/coin.mv");
    const module = try binary.deserialize(alloc, data);

    const output = try printModule(alloc, &module);
    // Should start with module declaration
    try testing.expect(std.mem.startsWith(u8, output, "module 0x"));
    // Should contain "coin"
    try testing.expect(std.mem.indexOf(u8, output, "::coin {") != null);
    // Should contain struct declarations
    try testing.expect(std.mem.indexOf(u8, output, "struct Coin") != null);
    try testing.expect(std.mem.indexOf(u8, output, "struct TreasuryCap") != null);
    // Should contain function declarations
    try testing.expect(std.mem.indexOf(u8, output, "fun total_supply") != null);
    try testing.expect(std.mem.indexOf(u8, output, "fun create_currency") != null);
    // Should contain abilities
    // Should contain abilities (format may vary)
    try testing.expect(std.mem.indexOf(u8, output, "has") != null);
}

test "printer: balance module" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const alloc = arena.allocator();

    const data = @embedFile("test_data/balance.mv");
    const module = try binary.deserialize(alloc, data);

    const output = try printModule(alloc, &module);
    try testing.expect(std.mem.indexOf(u8, output, "::balance {") != null);
    try testing.expect(std.mem.indexOf(u8, output, "struct Balance") != null);
    try testing.expect(std.mem.indexOf(u8, output, "struct Supply") != null);
}
