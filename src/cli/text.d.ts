// esbuild bundles these as text (scripts/build.mjs): the CLI writes the routing callback out (AFD-58).
declare module '*.py' {
  const text: string;
  export default text;
}
