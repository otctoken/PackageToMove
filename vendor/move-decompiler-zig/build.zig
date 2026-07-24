const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.addModule("move-decompiler", .{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    const tests = b.addTest(.{ .root_module = mod });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&run_tests.step);

    // CLI binary
    const cli_mod = b.addModule("cli", .{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    cli_mod.addImport("move-decompiler", mod);

    const cli = b.addExecutable(.{
        .name = "move-decompile",
        .root_module = cli_mod,
    });
    b.installArtifact(cli);

    // WASM library
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    const wasm_mod = b.addModule("wasm", .{
        .root_source_file = b.path("src/wasm.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
    });

    const wasm_lib = b.addExecutable(.{
        .name = "move_decompiler",
        .root_module = wasm_mod,
    });
    wasm_lib.entry = .disabled;
    wasm_lib.export_memory = true;
    wasm_lib.rdynamic = true;

    const wasm_step = b.step("wasm", "Build WASM library");
    const install_wasm = b.addInstallArtifact(wasm_lib, .{});
    wasm_step.dependOn(&install_wasm.step);
}
