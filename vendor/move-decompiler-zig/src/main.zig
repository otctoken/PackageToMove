const std = @import("std");
const decompiler = @import("move-decompiler");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();

    // Use arena for all decompilation (one big alloc, one big free)
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    var args = std.process.args();
    _ = args.skip();
    const file_path = args.next() orelse {
        std.debug.print("Usage: move-decompile <file.mv>\n", .{});
        return;
    };

    const data = std.fs.cwd().readFileAlloc(allocator, file_path, 10 * 1024 * 1024) catch |err| {
        std.debug.print("Error reading file: {}\n", .{err});
        return;
    };

    const output = decompiler.decompile(allocator, data) catch |err| {
        std.debug.print("Error decompiling: {}\n", .{err});
        return;
    };

    const stdout = std.fs.File{ .handle = std.posix.STDOUT_FILENO };
    try stdout.writeAll(output);
}
