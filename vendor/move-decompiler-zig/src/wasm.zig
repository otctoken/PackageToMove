const std = @import("std");
const lib = @import("lib.zig");

// WASM uses a fixed buffer allocator backed by WASM linear memory
var wasm_buf: [4 * 1024 * 1024]u8 = undefined; // 4MB
var fba = std.heap.FixedBufferAllocator.init(&wasm_buf);

// Shared output buffer
var output_buf: [1024 * 1024]u8 = undefined; // 1MB for output
var output_len: usize = 0;

/// Decompile a .mv module. Returns pointer to output string.
export fn decompile(input_ptr: [*]const u8, input_len: usize) usize {
    fba.reset();
    const allocator = fba.allocator();

    const input = input_ptr[0..input_len];
    const result = lib.decompile(allocator, input) catch {
        const err_msg = "Error: decompilation failed";
        @memcpy(output_buf[0..err_msg.len], err_msg);
        output_len = err_msg.len;
        return 0;
    };

    const copy_len = @min(result.len, output_buf.len);
    @memcpy(output_buf[0..copy_len], result[0..copy_len]);
    output_len = copy_len;
    return copy_len;
}

/// Get pointer to output buffer (for JS to read)
export fn get_output_ptr() [*]const u8 {
    return &output_buf;
}

/// Get pointer to input buffer (for JS to write module bytes)
export fn get_input_ptr() [*]u8 {
    // Use the end of wasm_buf as input staging area
    return @ptrCast(&wasm_buf[3 * 1024 * 1024]);
}

/// Get max input size
export fn get_max_input_size() usize {
    return 1024 * 1024; // 1MB max input
}
