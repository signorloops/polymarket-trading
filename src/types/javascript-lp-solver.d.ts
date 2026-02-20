declare module 'javascript-lp-solver' {
  const solver: {
    Solve: (model: unknown) => Record<string, unknown>;
  };

  export default solver;
}
