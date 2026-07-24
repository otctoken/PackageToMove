const std = @import("std");

// ── Index Types ───────────────────────────────────────────────────────

pub const ModuleHandleIndex = u16;
pub const DatatypeHandleIndex = u16;
pub const FunctionHandleIndex = u16;
pub const FieldHandleIndex = u16;
pub const StructDefIndex = u16;
pub const EnumDefIndex = u16;
pub const FunctionDefIndex = u16;
pub const FunctionInstIndex = u16;
pub const StructDefInstIndex = u16;
pub const EnumDefInstIndex = u16;
pub const FieldInstIndex = u16;
pub const VariantHandleIndex = u16;
pub const VariantInstHandleIndex = u16;
pub const IdentifierIndex = u16;
pub const AddressIdentifierIndex = u16;
pub const ConstantPoolIndex = u16;
pub const SignatureIndex = u16;
pub const LocalIndex = u8;
pub const CodeOffset = u16;
pub const TypeParameterIndex = u16;

// ── Abilities ─────────────────────────────────────────────────────────

pub const AbilitySet = packed struct {
    copy: bool = false,
    drop: bool = false,
    store: bool = false,
    key: bool = false,
    _pad: u4 = 0,

    pub fn fromByte(b: u8) AbilitySet {
        return @bitCast(b);
    }

    pub fn toByte(self: AbilitySet) u8 {
        return @bitCast(self);
    }

    pub fn format(self: AbilitySet) []const u8 {
        if (self.copy and self.drop and self.store and self.key) return "copy + drop + store + key";
        if (self.copy and self.drop) return "copy + drop";
        if (self.key and self.store) return "key + store";
        if (self.key) return "key";
        if (self.store) return "store";
        if (self.copy) return "copy";
        if (self.drop) return "drop";
        return "";
    }
};

// ── Visibility ────────────────────────────────────────────────────────

pub const Visibility = enum(u8) {
    private = 0x0,
    public = 0x1,
    deprecated_script = 0x2,
    friend = 0x3,
};

// ── Signature Tokens (types) ──────────────────────────────────────────

pub const SignatureToken = union(enum) {
    bool,
    u8,
    u16,
    u32,
    u64,
    u128,
    u256,
    address,
    signer,
    vector: *const SignatureToken,
    reference: *const SignatureToken,
    mutable_reference: *const SignatureToken,
    datatype: DatatypeHandleIndex,
    datatype_instantiation: struct {
        handle: DatatypeHandleIndex,
        type_arguments: []const *const SignatureToken,
    },
    type_parameter: TypeParameterIndex,
};

// ── Module Handle ─────────────────────────────────────────────────────

pub const ModuleHandle = struct {
    address: AddressIdentifierIndex,
    name: IdentifierIndex,
};

// ── Datatype Handle ───────────────────────────────────────────────────

pub const DatatypeTyParameter = struct {
    constraints: AbilitySet,
    is_phantom: bool,
};

pub const DatatypeHandle = struct {
    module: ModuleHandleIndex,
    name: IdentifierIndex,
    abilities: AbilitySet,
    type_parameters: []const DatatypeTyParameter,
};

// ── Function Handle ───────────────────────────────────────────────────

pub const FunctionHandle = struct {
    module: ModuleHandleIndex,
    name: IdentifierIndex,
    parameters: SignatureIndex,
    return_: SignatureIndex,
    type_parameters: []const AbilitySet,
};

// ── Struct / Enum Definitions ─────────────────────────────────────────

pub const FieldDefinition = struct {
    name: IdentifierIndex,
    signature: *const SignatureToken,
};

pub const FieldInfo = union(enum) {
    native,
    declared: []const FieldDefinition,
};

pub const StructDefinition = struct {
    struct_handle: DatatypeHandleIndex,
    field_info: FieldInfo,
};

pub const VariantDefinition = struct {
    name: IdentifierIndex,
    fields: []const FieldDefinition,
};

pub const EnumDefinition = struct {
    enum_handle: DatatypeHandleIndex,
    variants: []const VariantDefinition,
};

// ── Instantiations ────────────────────────────────────────────────────

pub const FunctionInstantiation = struct {
    handle: FunctionHandleIndex,
    type_parameters: SignatureIndex,
};

pub const StructDefInstantiation = struct {
    def: StructDefIndex,
    type_parameters: SignatureIndex,
};

pub const EnumDefInstantiation = struct {
    def: EnumDefIndex,
    type_parameters: SignatureIndex,
};

pub const FieldHandle = struct {
    owner: StructDefIndex,
    field: u16,
};

pub const FieldInstantiation = struct {
    handle: FieldHandleIndex,
    type_parameters: SignatureIndex,
};

pub const VariantHandle = struct {
    enum_def: EnumDefIndex,
    variant: u16,
};

pub const VariantInstHandle = struct {
    enum_def_inst: EnumDefInstIndex,
    variant: u16,
};

// ── Constants ─────────────────────────────────────────────────────────

pub const Constant = struct {
    type_: *const SignatureToken,
    data: []const u8,
};

// ── Metadata ──────────────────────────────────────────────────────────

pub const Metadata = struct {
    key: []const u8,
    value: []const u8,
};

// ── Signature (vec of types) ──────────────────────────────────────────

pub const Signature = struct {
    tokens: []const *const SignatureToken,
};

// ── Bytecode Instructions ─────────────────────────────────────────────

pub const Bytecode = union(enum) {
    pop,
    ret,
    nop,
    ld_true,
    ld_false,
    read_ref,
    write_ref,
    freeze_ref,
    abort,
    // Arithmetic
    add,
    sub,
    mul,
    mod,
    div,
    bit_or,
    bit_and,
    xor,
    shl,
    shr,
    @"or",
    @"and",
    not,
    // Comparison
    eq,
    neq,
    lt,
    gt,
    le,
    ge,
    // Cast
    cast_u8,
    cast_u16,
    cast_u32,
    cast_u64,
    cast_u128,
    cast_u256,
    // Load immediates
    ld_u8: u8,
    ld_u16: u16,
    ld_u32: u32,
    ld_u64: u64,
    ld_u128: u128,
    ld_u256: u256,
    ld_const: ConstantPoolIndex,
    // Branches
    br_true: CodeOffset,
    br_false: CodeOffset,
    branch: CodeOffset,
    // Locals
    copy_loc: LocalIndex,
    move_loc: LocalIndex,
    st_loc: LocalIndex,
    mut_borrow_loc: LocalIndex,
    imm_borrow_loc: LocalIndex,
    // Function calls
    call: FunctionHandleIndex,
    call_generic: FunctionInstIndex,
    // Struct ops
    pack: StructDefIndex,
    pack_generic: StructDefInstIndex,
    unpack: StructDefIndex,
    unpack_generic: StructDefInstIndex,
    // Field access
    mut_borrow_field: FieldHandleIndex,
    mut_borrow_field_generic: FieldInstIndex,
    imm_borrow_field: FieldHandleIndex,
    imm_borrow_field_generic: FieldInstIndex,
    // Vector ops
    vec_pack: struct { sig: SignatureIndex, len: u64 },
    vec_len: SignatureIndex,
    vec_imm_borrow: SignatureIndex,
    vec_mut_borrow: SignatureIndex,
    vec_push_back: SignatureIndex,
    vec_pop_back: SignatureIndex,
    vec_unpack: struct { sig: SignatureIndex, len: u64 },
    vec_swap: SignatureIndex,
    // Enum ops (v7+)
    pack_variant: VariantHandleIndex,
    pack_variant_generic: VariantInstHandleIndex,
    unpack_variant: VariantHandleIndex,
    unpack_variant_imm_ref: VariantHandleIndex,
    unpack_variant_mut_ref: VariantHandleIndex,
    unpack_variant_generic: VariantInstHandleIndex,
    unpack_variant_generic_imm_ref: VariantInstHandleIndex,
    unpack_variant_generic_mut_ref: VariantInstHandleIndex,
    variant_switch: u16, // jump table index
    // Deprecated global ops (still need to parse)
    exists_deprecated: StructDefIndex,
    mut_borrow_global_deprecated: StructDefIndex,
    imm_borrow_global_deprecated: StructDefIndex,
    move_from_deprecated: StructDefIndex,
    move_to_deprecated: StructDefIndex,
    exists_generic_deprecated: StructDefInstIndex,
    mut_borrow_global_generic_deprecated: StructDefInstIndex,
    imm_borrow_global_generic_deprecated: StructDefInstIndex,
    move_from_generic_deprecated: StructDefInstIndex,
    move_to_generic_deprecated: StructDefInstIndex,

    pub fn isBranch(self: Bytecode) bool {
        return switch (self) {
            .br_true, .br_false, .branch, .ret, .abort, .variant_switch => true,
            else => false,
        };
    }

    pub fn branchTarget(self: Bytecode) ?CodeOffset {
        return switch (self) {
            .br_true => |t| t,
            .br_false => |t| t,
            .branch => |t| t,
            else => null,
        };
    }
};

// ── Code Unit ─────────────────────────────────────────────────────────

pub const VariantJumpTable = struct {
    head_enum: EnumDefIndex,
    offsets: []const CodeOffset,
};

pub const CodeUnit = struct {
    locals: SignatureIndex,
    code: []const Bytecode,
    jump_tables: []const VariantJumpTable,
};

// ── Function Definition ───────────────────────────────────────────────

pub const FunctionDefinition = struct {
    function: FunctionHandleIndex,
    visibility: Visibility,
    is_entry: bool,
    is_native: bool,
    acquires_global_resources: []const StructDefIndex,
    code: ?CodeUnit,
};

// ── Compiled Module (top-level) ───────────────────────────────────────

pub const CompiledModule = struct {
    version: u32,
    self_module_handle_idx: ModuleHandleIndex,

    module_handles: []const ModuleHandle,
    datatype_handles: []const DatatypeHandle,
    function_handles: []const FunctionHandle,
    function_instantiations: []const FunctionInstantiation,
    signatures: []const Signature,
    identifiers: []const []const u8,
    address_identifiers: []const [32]u8,
    constant_pool: []const Constant,
    metadata: []const Metadata,

    struct_defs: []const StructDefinition,
    struct_def_instantiations: []const StructDefInstantiation,
    function_defs: []const FunctionDefinition,
    field_handles: []const FieldHandle,
    field_instantiations: []const FieldInstantiation,
    friend_decls: []const ModuleHandle,

    enum_defs: []const EnumDefinition,
    enum_def_instantiations: []const EnumDefInstantiation,
    variant_handles: []const VariantHandle,
    variant_inst_handles: []const VariantInstHandle,

    pub fn selfModuleName(self: *const CompiledModule) []const u8 {
        const mh = self.module_handles[self.self_module_handle_idx];
        return self.identifiers[mh.name];
    }

    pub fn selfModuleAddress(self: *const CompiledModule) [32]u8 {
        const mh = self.module_handles[self.self_module_handle_idx];
        return self.address_identifiers[mh.address];
    }
};
