const std = @import("std");
const types = @import("types.zig");
const Allocator = std.mem.Allocator;

pub const Error = error{
    InvalidMagic,
    UnsupportedVersion,
    InvalidTableType,
    InvalidSignatureToken,
    InvalidBytecode,
    InvalidVisibility,
    InvalidFieldInfo,
    InvalidJumpTableType,
    UnexpectedEndOfInput,
    Overflow,
    OutOfMemory,
};

// ── Constants ─────────────────────────────────────────────────────────

const MAGIC: [4]u8 = .{ 0xA1, 0x1C, 0xEB, 0x0B };
const MAGIC_UNPUBLISHABLE: [4]u8 = .{ 0xDE, 0xAD, 0xC0, 0xDE };
const SUI_FLAVOR: u8 = 0x05;
const VERSION_MIN: u32 = 5;
const VERSION_MAX: u32 = 7;
const TABLE_HEADER_SIZE: usize = 9;

const TableType = enum(u8) {
    module_handles = 0x1,
    datatype_handles = 0x2,
    function_handles = 0x3,
    function_instantiations = 0x4,
    signatures = 0x5,
    constant_pool = 0x6,
    identifiers = 0x7,
    address_identifiers = 0x8,
    // 0x9 is skipped
    struct_defs = 0xA,
    struct_def_instantiations = 0xB,
    function_defs = 0xC,
    field_handles = 0xD,
    field_instantiations = 0xE,
    friend_decls = 0xF,
    metadata = 0x10,
    enum_defs = 0x11,
    enum_def_instantiations = 0x12,
    variant_handles = 0x13,
    variant_inst_handles = 0x14,
    _,
};

// ── Reader ────────────────────────────────────────────────────────────

const Reader = struct {
    data: []const u8,
    pos: usize,

    fn readByte(self: *Reader) Error!u8 {
        if (self.pos >= self.data.len) return Error.UnexpectedEndOfInput;
        const b = self.data[self.pos];
        self.pos += 1;
        return b;
    }

    fn readBytes(self: *Reader, n: usize) Error![]const u8 {
        if (self.pos + n > self.data.len) return Error.UnexpectedEndOfInput;
        const slice = self.data[self.pos .. self.pos + n];
        self.pos += n;
        return slice;
    }

    fn readU16LE(self: *Reader) Error!u16 {
        const bytes = try self.readBytes(2);
        return @as(u16, bytes[0]) | (@as(u16, bytes[1]) << 8);
    }

    fn readU32LE(self: *Reader) Error!u32 {
        const bytes = try self.readBytes(4);
        return @as(u32, bytes[0]) | (@as(u32, bytes[1]) << 8) |
            (@as(u32, bytes[2]) << 16) | (@as(u32, bytes[3]) << 24);
    }

    fn readU64LE(self: *Reader) Error!u64 {
        const bytes = try self.readBytes(8);
        var result: u64 = 0;
        for (0..8) |i| result |= @as(u64, bytes[i]) << @intCast(i * 8);
        return result;
    }

    fn readU128LE(self: *Reader) Error!u128 {
        const bytes = try self.readBytes(16);
        var result: u128 = 0;
        for (0..16) |i| result |= @as(u128, bytes[i]) << @intCast(i * 8);
        return result;
    }

    fn readU256LE(self: *Reader) Error!u256 {
        const bytes = try self.readBytes(32);
        var result: u256 = 0;
        for (0..32) |i| result |= @as(u256, bytes[i]) << @intCast(i * 8);
        return result;
    }

    fn readULEB128(self: *Reader) Error!u32 {
        var result: u32 = 0;
        var shift: u5 = 0;
        while (true) {
            const b = try self.readByte();
            result |= @as(u32, b & 0x7F) << shift;
            if (b & 0x80 == 0) return result;
            shift = std.math.add(u5, shift, 7) catch return Error.Overflow;
        }
    }

    fn readULEB128_u16(self: *Reader) Error!u16 {
        const val = try self.readULEB128();
        if (val > std.math.maxInt(u16)) return Error.Overflow;
        return @intCast(val);
    }

    fn readAddress(self: *Reader) Error![32]u8 {
        const bytes = try self.readBytes(32);
        var addr: [32]u8 = undefined;
        @memcpy(&addr, bytes);
        return addr;
    }
};

// ── Signature Token Parsing ───────────────────────────────────────────

fn readSignatureToken(allocator: Allocator, reader: *Reader) Error!*const types.SignatureToken {
    const tag = try reader.readByte();
    const token = try allocator.create(types.SignatureToken);

    switch (tag) {
        0x1 => token.* = .bool,
        0x2 => token.* = .u8,
        0xD => token.* = .u16,
        0xE => token.* = .u32,
        0x3 => token.* = .u64,
        0x4 => token.* = .u128,
        0xF => token.* = .u256,
        0x5 => token.* = .address,
        0xC => token.* = .signer,
        0xA => {
            const inner = try readSignatureToken(allocator, reader);
            token.* = .{ .vector = inner };
        },
        0x6 => {
            const inner = try readSignatureToken(allocator, reader);
            token.* = .{ .reference = inner };
        },
        0x7 => {
            const inner = try readSignatureToken(allocator, reader);
            token.* = .{ .mutable_reference = inner };
        },
        0x8 => {
            const idx = try reader.readULEB128_u16();
            token.* = .{ .datatype = idx };
        },
        0xB => {
            const handle = try reader.readULEB128_u16();
            const arity = try reader.readULEB128();
            const type_args = try allocator.alloc(*const types.SignatureToken, arity);
            for (0..arity) |i| {
                type_args[i] = try readSignatureToken(allocator, reader);
            }
            token.* = .{ .datatype_instantiation = .{
                .handle = handle,
                .type_arguments = type_args,
            } };
        },
        0x9 => {
            const idx = try reader.readULEB128_u16();
            token.* = .{ .type_parameter = idx };
        },
        else => return Error.InvalidSignatureToken,
    }
    return token;
}

// ── Bytecode Parsing ──────────────────────────────────────────────────

fn readBytecode(reader: *Reader) Error!types.Bytecode {
    const opcode = try reader.readByte();
    return switch (opcode) {
        0x01 => .pop,
        0x02 => .ret,
        0x08 => .ld_true,
        0x09 => .ld_false,
        0x14 => .read_ref,
        0x15 => .write_ref,
        0x2E => .freeze_ref,
        0x27 => .abort,
        0x28 => .nop,
        0x16 => .add,
        0x17 => .sub,
        0x18 => .mul,
        0x19 => .mod,
        0x1A => .div,
        0x1B => .bit_or,
        0x1C => .bit_and,
        0x1D => .xor,
        0x2F => .shl,
        0x30 => .shr,
        0x1E => .@"or",
        0x1F => .@"and",
        0x20 => .not,
        0x21 => .eq,
        0x22 => .neq,
        0x23 => .lt,
        0x24 => .gt,
        0x25 => .le,
        0x26 => .ge,
        0x33 => .cast_u8,
        0x34 => .cast_u64,
        0x35 => .cast_u128,
        0x4B => .cast_u16,
        0x4C => .cast_u32,
        0x4D => .cast_u256,
        // Load immediates
        0x31 => .{ .ld_u8 = try reader.readByte() },
        0x48 => .{ .ld_u16 = try reader.readU16LE() },
        0x49 => .{ .ld_u32 = try reader.readU32LE() },
        0x06 => .{ .ld_u64 = try reader.readU64LE() },
        0x32 => .{ .ld_u128 = try reader.readU128LE() },
        0x4A => .{ .ld_u256 = try reader.readU256LE() },
        0x07 => .{ .ld_const = try reader.readULEB128_u16() },
        // Branches (ULEB128 code offset)
        0x03 => .{ .br_true = try reader.readULEB128_u16() },
        0x04 => .{ .br_false = try reader.readULEB128_u16() },
        0x05 => .{ .branch = try reader.readULEB128_u16() },
        // Locals (ULEB128 → u8)
        0x0A => .{ .copy_loc = @intCast(try reader.readULEB128()) },
        0x0B => .{ .move_loc = @intCast(try reader.readULEB128()) },
        0x0C => .{ .st_loc = @intCast(try reader.readULEB128()) },
        0x0D => .{ .mut_borrow_loc = @intCast(try reader.readULEB128()) },
        0x0E => .{ .imm_borrow_loc = @intCast(try reader.readULEB128()) },
        // Function calls
        0x11 => .{ .call = try reader.readULEB128_u16() },
        0x38 => .{ .call_generic = try reader.readULEB128_u16() },
        // Struct ops
        0x12 => .{ .pack = try reader.readULEB128_u16() },
        0x39 => .{ .pack_generic = try reader.readULEB128_u16() },
        0x13 => .{ .unpack = try reader.readULEB128_u16() },
        0x3A => .{ .unpack_generic = try reader.readULEB128_u16() },
        // Field access
        0x0F => .{ .mut_borrow_field = try reader.readULEB128_u16() },
        0x36 => .{ .mut_borrow_field_generic = try reader.readULEB128_u16() },
        0x10 => .{ .imm_borrow_field = try reader.readULEB128_u16() },
        0x37 => .{ .imm_borrow_field_generic = try reader.readULEB128_u16() },
        // Vector ops
        0x40 => .{ .vec_pack = .{ .sig = try reader.readULEB128_u16(), .len = try reader.readU64LE() } },
        0x41 => .{ .vec_len = try reader.readULEB128_u16() },
        0x42 => .{ .vec_imm_borrow = try reader.readULEB128_u16() },
        0x43 => .{ .vec_mut_borrow = try reader.readULEB128_u16() },
        0x44 => .{ .vec_push_back = try reader.readULEB128_u16() },
        0x45 => .{ .vec_pop_back = try reader.readULEB128_u16() },
        0x46 => .{ .vec_unpack = .{ .sig = try reader.readULEB128_u16(), .len = try reader.readU64LE() } },
        0x47 => .{ .vec_swap = try reader.readULEB128_u16() },
        // Enum ops (v7+)
        0x4E => .{ .pack_variant = try reader.readULEB128_u16() },
        0x4F => .{ .pack_variant_generic = try reader.readULEB128_u16() },
        0x50 => .{ .unpack_variant = try reader.readULEB128_u16() },
        0x51 => .{ .unpack_variant_imm_ref = try reader.readULEB128_u16() },
        0x52 => .{ .unpack_variant_mut_ref = try reader.readULEB128_u16() },
        0x53 => .{ .unpack_variant_generic = try reader.readULEB128_u16() },
        0x54 => .{ .unpack_variant_generic_imm_ref = try reader.readULEB128_u16() },
        0x55 => .{ .unpack_variant_generic_mut_ref = try reader.readULEB128_u16() },
        0x56 => .{ .variant_switch = try reader.readULEB128_u16() },
        // Deprecated global ops
        0x29 => .{ .exists_deprecated = try reader.readULEB128_u16() },
        0x2A => .{ .mut_borrow_global_deprecated = try reader.readULEB128_u16() },
        0x2B => .{ .imm_borrow_global_deprecated = try reader.readULEB128_u16() },
        0x2C => .{ .move_from_deprecated = try reader.readULEB128_u16() },
        0x2D => .{ .move_to_deprecated = try reader.readULEB128_u16() },
        0x3B => .{ .exists_generic_deprecated = try reader.readULEB128_u16() },
        0x3C => .{ .mut_borrow_global_generic_deprecated = try reader.readULEB128_u16() },
        0x3D => .{ .imm_borrow_global_generic_deprecated = try reader.readULEB128_u16() },
        0x3E => .{ .move_from_generic_deprecated = try reader.readULEB128_u16() },
        0x3F => .{ .move_to_generic_deprecated = try reader.readULEB128_u16() },
        else => return Error.InvalidBytecode,
    };
}

// ── Table Parsers ─────────────────────────────────────────────────────

fn readModuleHandles(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.ModuleHandle {
    var list = std.ArrayList(types.ModuleHandle){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .address = try reader.readULEB128_u16(),
            .name = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readDatatypeHandles(allocator: Allocator, reader: *Reader, end: usize, version: u32) Error![]const types.DatatypeHandle {
    var list = std.ArrayList(types.DatatypeHandle){};
    while (reader.pos < end) {
        const module = try reader.readULEB128_u16();
        const name = try reader.readULEB128_u16();
        const abilities = types.AbilitySet.fromByte(@intCast(try reader.readULEB128()));
        const tp_count = try reader.readULEB128();
        const tps = try allocator.alloc(types.DatatypeTyParameter, tp_count);
        for (0..tp_count) |i| {
            const constraints = types.AbilitySet.fromByte(@intCast(try reader.readULEB128()));
            const is_phantom = if (version >= 3) (try reader.readULEB128()) != 0 else false;
            tps[i] = .{ .constraints = constraints, .is_phantom = is_phantom };
        }
        try list.append(allocator, .{
            .module = module,
            .name = name,
            .abilities = abilities,
            .type_parameters = tps,
        });
    }
    return list.items;
}

fn readFunctionHandles(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.FunctionHandle {
    var list = std.ArrayList(types.FunctionHandle){};
    while (reader.pos < end) {
        const module = try reader.readULEB128_u16();
        const name = try reader.readULEB128_u16();
        const params = try reader.readULEB128_u16();
        const ret = try reader.readULEB128_u16();
        const tp_count = try reader.readULEB128();
        const tps = try allocator.alloc(types.AbilitySet, tp_count);
        for (0..tp_count) |i| {
            tps[i] = types.AbilitySet.fromByte(@intCast(try reader.readULEB128()));
        }
        try list.append(allocator, .{
            .module = module,
            .name = name,
            .parameters = params,
            .return_ = ret,
            .type_parameters = tps,
        });
    }
    return list.items;
}

fn readFunctionInstantiations(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.FunctionInstantiation {
    var list = std.ArrayList(types.FunctionInstantiation){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .handle = try reader.readULEB128_u16(),
            .type_parameters = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readSignatures(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.Signature {
    var list = std.ArrayList(types.Signature){};
    while (reader.pos < end) {
        const count = try reader.readULEB128();
        const tokens = try allocator.alloc(*const types.SignatureToken, count);
        for (0..count) |i| {
            tokens[i] = try readSignatureToken(allocator, reader);
        }
        try list.append(allocator, .{ .tokens = tokens });
    }
    return list.items;
}

fn readConstants(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.Constant {
    var list = std.ArrayList(types.Constant){};
    while (reader.pos < end) {
        const type_ = try readSignatureToken(allocator, reader);
        const data_len = try reader.readULEB128();
        const data = try reader.readBytes(data_len);
        const owned = try allocator.dupe(u8, data);
        try list.append(allocator, .{ .type_ = type_, .data = owned });
    }
    return list.items;
}

fn readIdentifiers(allocator: Allocator, reader: *Reader, end: usize) Error![]const []const u8 {
    var list = std.ArrayList([]const u8){};
    while (reader.pos < end) {
        const len = try reader.readULEB128();
        const bytes = try reader.readBytes(len);
        const owned = try allocator.dupe(u8, bytes);
        try list.append(allocator, owned);
    }
    return list.items;
}

fn readAddressIdentifiers(allocator: Allocator, reader: *Reader, end: usize) Error![]const [32]u8 {
    var list = std.ArrayList([32]u8){};
    while (reader.pos < end) {
        try list.append(allocator, try reader.readAddress());
    }
    return list.items;
}

fn readStructDefs(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.StructDefinition {
    var list = std.ArrayList(types.StructDefinition){};
    while (reader.pos < end) {
        const handle = try reader.readULEB128_u16();
        const flag = try reader.readByte();
        const field_info: types.FieldInfo = switch (flag) {
            0x1 => .native,
            0x2 => blk: {
                const field_count = try reader.readULEB128();
                const fields = try allocator.alloc(types.FieldDefinition, field_count);
                for (0..field_count) |i| {
                    fields[i] = .{
                        .name = try reader.readULEB128_u16(),
                        .signature = try readSignatureToken(allocator, reader),
                    };
                }
                break :blk .{ .declared = fields };
            },
            else => return Error.InvalidFieldInfo,
        };
        try list.append(allocator, .{ .struct_handle = handle, .field_info = field_info });
    }
    return list.items;
}

fn readStructDefInstantiations(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.StructDefInstantiation {
    var list = std.ArrayList(types.StructDefInstantiation){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .def = try reader.readULEB128_u16(),
            .type_parameters = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readFieldHandles(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.FieldHandle {
    var list = std.ArrayList(types.FieldHandle){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .owner = try reader.readULEB128_u16(),
            .field = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readFieldInstantiations(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.FieldInstantiation {
    var list = std.ArrayList(types.FieldInstantiation){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .handle = try reader.readULEB128_u16(),
            .type_parameters = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readMetadata(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.Metadata {
    var list = std.ArrayList(types.Metadata){};
    while (reader.pos < end) {
        const key_len = try reader.readULEB128();
        const key = try allocator.dupe(u8, try reader.readBytes(key_len));
        const val_len = try reader.readULEB128();
        const val = try allocator.dupe(u8, try reader.readBytes(val_len));
        try list.append(allocator, .{ .key = key, .value = val });
    }
    return list.items;
}

fn readEnumDefs(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.EnumDefinition {
    var list = std.ArrayList(types.EnumDefinition){};
    while (reader.pos < end) {
        const handle = try reader.readULEB128_u16();
        const flag = try reader.readByte();
        if (flag != 0x2) return Error.InvalidFieldInfo;
        const variant_count = try reader.readULEB128();
        const variants = try allocator.alloc(types.VariantDefinition, variant_count);
        for (0..variant_count) |vi| {
            const name = try reader.readULEB128_u16();
            const field_count = try reader.readULEB128();
            const fields = try allocator.alloc(types.FieldDefinition, field_count);
            for (0..field_count) |fi| {
                fields[fi] = .{
                    .name = try reader.readULEB128_u16(),
                    .signature = try readSignatureToken(allocator, reader),
                };
            }
            variants[vi] = .{ .name = name, .fields = fields };
        }
        try list.append(allocator, .{ .enum_handle = handle, .variants = variants });
    }
    return list.items;
}

fn readEnumDefInstantiations(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.EnumDefInstantiation {
    var list = std.ArrayList(types.EnumDefInstantiation){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .def = try reader.readULEB128_u16(),
            .type_parameters = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readVariantHandles(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.VariantHandle {
    var list = std.ArrayList(types.VariantHandle){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .enum_def = try reader.readULEB128_u16(),
            .variant = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readVariantInstHandles(allocator: Allocator, reader: *Reader, end: usize) Error![]const types.VariantInstHandle {
    var list = std.ArrayList(types.VariantInstHandle){};
    while (reader.pos < end) {
        try list.append(allocator, .{
            .enum_def_inst = try reader.readULEB128_u16(),
            .variant = try reader.readULEB128_u16(),
        });
    }
    return list.items;
}

fn readCodeUnit(allocator: Allocator, reader: *Reader, version: u32) Error!types.CodeUnit {
    const locals = try reader.readULEB128_u16();
    const code_count = try reader.readULEB128();
    const code = try allocator.alloc(types.Bytecode, code_count);
    for (0..code_count) |i| {
        code[i] = try readBytecode(reader);
    }
    var jump_tables: []const types.VariantJumpTable = &.{};
    if (version >= 7) {
        const jt_count = try reader.readULEB128();
        if (jt_count > 0) {
            const jts = try allocator.alloc(types.VariantJumpTable, jt_count);
            for (0..jt_count) |i| {
                const head_enum = try reader.readULEB128_u16();
                const branch_count = try reader.readULEB128_u16();
                const jt_type = try reader.readByte();
                if (jt_type != 0x1) return Error.InvalidJumpTableType;
                const offsets = try allocator.alloc(types.CodeOffset, branch_count);
                for (0..branch_count) |j| {
                    offsets[j] = try reader.readULEB128_u16();
                }
                jts[i] = .{ .head_enum = head_enum, .offsets = offsets };
            }
            jump_tables = jts;
        }
    }
    return .{ .locals = locals, .code = code, .jump_tables = jump_tables };
}

fn readFunctionDefs(allocator: Allocator, reader: *Reader, end: usize, version: u32) Error![]const types.FunctionDefinition {
    var list = std.ArrayList(types.FunctionDefinition){};
    while (reader.pos < end) {
        const function = try reader.readULEB128_u16();
        const vis_byte = try reader.readByte();
        const visibility: types.Visibility = switch (vis_byte) {
            0x0 => .private,
            0x1 => .public,
            0x2 => .deprecated_script,
            0x3 => .friend,
            else => return Error.InvalidVisibility,
        };
        const extra_flags = try reader.readByte();
        const is_native = (extra_flags & 0x2) != 0;
        const is_entry = if (version >= 5) (extra_flags & 0x4) != 0 else false;
        const acquires_count = try reader.readULEB128();
        const acquires = try allocator.alloc(types.StructDefIndex, acquires_count);
        for (0..acquires_count) |i| {
            acquires[i] = try reader.readULEB128_u16();
        }
        const code = if (!is_native) try readCodeUnit(allocator, reader, version) else null;
        try list.append(allocator, .{
            .function = function,
            .visibility = visibility,
            .is_entry = is_entry,
            .is_native = is_native,
            .acquires_global_resources = acquires,
            .code = code,
        });
    }
    return list.items;
}

// ── Main Deserializer ─────────────────────────────────────────────────

pub fn deserialize(allocator: Allocator, data: []const u8) Error!types.CompiledModule {
    var reader = Reader{ .data = data, .pos = 0 };

    // Header
    const magic = try reader.readBytes(4);
    if (!std.mem.eql(u8, magic, &MAGIC) and !std.mem.eql(u8, magic, &MAGIC_UNPUBLISHABLE))
        return Error.InvalidMagic;

    const raw_version = try reader.readU32LE();
    const version = if ((raw_version >> 24) == SUI_FLAVOR)
        raw_version & 0x00FFFFFF
    else
        raw_version;
    if (version < VERSION_MIN or version > VERSION_MAX)
        return Error.UnsupportedVersion;

    const table_count: usize = try reader.readULEB128();

    // Table headers: kind(u8) + offset(ULEB128) + size(ULEB128)
    const TableSpec = struct { kind: u8, offset: u32, length: u32 };
    const specs = try allocator.alloc(TableSpec, table_count);
    for (0..table_count) |i| {
        specs[i] = .{
            .kind = try reader.readByte(),
            .offset = try reader.readULEB128(),
            .length = try reader.readULEB128(),
        };
    }

    // Table data starts right after headers; offsets are relative to this position
    const tables_base = reader.pos;

    // Initialize empty slices
    var module = types.CompiledModule{
        .version = version,
        .self_module_handle_idx = 0,
        .module_handles = &.{},
        .datatype_handles = &.{},
        .function_handles = &.{},
        .function_instantiations = &.{},
        .signatures = &.{},
        .identifiers = &.{},
        .address_identifiers = &.{},
        .constant_pool = &.{},
        .metadata = &.{},
        .struct_defs = &.{},
        .struct_def_instantiations = &.{},
        .function_defs = &.{},
        .field_handles = &.{},
        .field_instantiations = &.{},
        .friend_decls = &.{},
        .enum_defs = &.{},
        .enum_def_instantiations = &.{},
        .variant_handles = &.{},
        .variant_inst_handles = &.{},
    };

    // Parse each table
    for (specs) |spec| {
        var table_reader = Reader{
            .data = data,
            .pos = tables_base + spec.offset,
        };
        const end = tables_base + spec.offset + spec.length;

        switch (@as(TableType, @enumFromInt(spec.kind))) {
            .module_handles => module.module_handles = try readModuleHandles(allocator, &table_reader, end),
            .datatype_handles => module.datatype_handles = try readDatatypeHandles(allocator, &table_reader, end, version),
            .function_handles => module.function_handles = try readFunctionHandles(allocator, &table_reader, end),
            .function_instantiations => module.function_instantiations = try readFunctionInstantiations(allocator, &table_reader, end),
            .signatures => module.signatures = try readSignatures(allocator, &table_reader, end),
            .constant_pool => module.constant_pool = try readConstants(allocator, &table_reader, end),
            .identifiers => module.identifiers = try readIdentifiers(allocator, &table_reader, end),
            .address_identifiers => module.address_identifiers = try readAddressIdentifiers(allocator, &table_reader, end),
            .struct_defs => module.struct_defs = try readStructDefs(allocator, &table_reader, end),
            .struct_def_instantiations => module.struct_def_instantiations = try readStructDefInstantiations(allocator, &table_reader, end),
            .function_defs => module.function_defs = try readFunctionDefs(allocator, &table_reader, end, version),
            .field_handles => module.field_handles = try readFieldHandles(allocator, &table_reader, end),
            .field_instantiations => module.field_instantiations = try readFieldInstantiations(allocator, &table_reader, end),
            .friend_decls => module.friend_decls = try readModuleHandles(allocator, &table_reader, end),
            .metadata => module.metadata = try readMetadata(allocator, &table_reader, end),
            .enum_defs => module.enum_defs = try readEnumDefs(allocator, &table_reader, end),
            .enum_def_instantiations => module.enum_def_instantiations = try readEnumDefInstantiations(allocator, &table_reader, end),
            .variant_handles => module.variant_handles = try readVariantHandles(allocator, &table_reader, end),
            .variant_inst_handles => module.variant_inst_handles = try readVariantInstHandles(allocator, &table_reader, end),
            _ => {}, // Skip unknown tables
        }
    }

    // Self module handle index is at the very end of the binary
    // Find the end of the last table
    var max_end: usize = tables_base;
    for (specs) |spec| {
        const end = tables_base + spec.offset + spec.length;
        if (end > max_end) max_end = end;
    }
    reader.pos = max_end;
    module.self_module_handle_idx = try reader.readULEB128_u16();

    return module;
}
