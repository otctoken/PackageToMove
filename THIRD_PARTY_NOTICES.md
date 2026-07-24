# Third-party notices

## move-decompiler-zig

The bundled file `public/move_decompiler.wasm` is built from
[unconfirmedlabs/move-decompiler-zig](https://github.com/unconfirmedlabs/move-decompiler-zig).
The corresponding source, including local CFG fixes, is vendored in
`vendor/move-decompiler-zig` from upstream commit
`bb699931141086521e492d172b7c6d5591759498`.

Copyright (c) the move-decompiler-zig contributors.

Licensed under the MIT License. Permission is hereby granted, free of charge, to
any person obtaining a copy of this software and associated documentation files
(the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom
the Software is furnished to do so, subject to the conditions in the upstream
license.

## MystenLabs Sui Move decompiler

The Rust Move bytecode parser, verifier, model, stackless-bytecode pipeline and
decompiler under `vendor/move-rust` are vendored from
[MystenLabs/sui](https://github.com/MystenLabs/sui) at commit
`26c78168d2be95e0686b8a604b3ad0ec763829c2`.

Copyright (c) The Move Contributors and their respective copyright holders.

Licensed under the Apache License, Version 2.0. The complete license text and
vendor-specific provenance are in `vendor/move-rust/LICENSE` and
`vendor/move-rust/UPSTREAM.md`.
