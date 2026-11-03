// The kit bundles the runner page as text (scripts/usability/bundle.mjs).
declare module '*.html' {
  const text: string;
  export default text;
}
