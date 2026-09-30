// A .wasm or .scm import (`with { type: 'file' }`) is the file's path, embedded in the compiled binary.
declare module '*.wasm' {
  const path: string;
  export default path;
}
declare module '*.scm' {
  const path: string;
  export default path;
}
