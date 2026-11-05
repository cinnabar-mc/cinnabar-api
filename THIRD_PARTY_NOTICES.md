# Scanner dependencies

The scanner uses Bytecode Alliance's
[`@bytecodealliance/jco-transpile`](https://github.com/bytecodealliance/jco),
licensed under Apache-2.0 with the LLVM exception. It uses trusted Jco/Wasmtime
translation and wasm-tools to inspect WebAssembly components without executing
uploaded code. Generated guest bindings are never imported or evaluated.

Raster decoding uses [`sharp`](https://github.com/lovell/sharp), licensed under
Apache-2.0. Its packaged native libraries retain their own notices and licenses.
Package managers install these dependencies and their notices; preserve them in
scanner distributions. The API repository's existing MIT license remains in effect.
