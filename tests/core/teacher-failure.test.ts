import { expect, it, vi } from 'vitest';

const solver = { solve: vi.fn() };
// Use the owning package's ESM entry; pnpm does not hoist HiGHS to root.
vi.doMock('../../packages/core/node_modules/highs/build/highs.mjs',
  () => ({ default: async () => solver }));

it('never converts a failed, unfinished or malformed solve into a training label', async () => {
  const { createValuationProblem, solveTeacher } = await import('../../packages/core/src/index.ts');
  const problem = createValuationProblem({ schemaVersion: 'valuation-v1', currency: 'USD', dataMode: 'synthetic',
    snapshotId: 'failure-fixture', rulesHash: 'a'.repeat(64), budgetUsd: '0',
    states: [{ stateId: 'loss', originalLossUsd: '10' }],
    legs: [{ legId: 'yes', minShares: '1', fee: { kind: 'none' }, asks: [],
      payouts: [{ stateId: 'loss', payoutPerShare: '1' }] }] });
  const riskSolution = { Status: 'Optimal', ObjectiveValue: 1_000_000, Columns: { q0: { Primal: 0 } } };
  for (const status of ['Time limit reached', 'Infeasible', 'Unknown']) {
    solver.solve.mockReset().mockReturnValue({ ...riskSolution, Status: status });
    await expect(solveTeacher(problem)).rejects.toMatchObject({ code: 'not_optimal' });
    solver.solve.mockReset().mockReturnValueOnce(riskSolution).mockReturnValue({ Status: status });
    await expect(solveTeacher(problem)).rejects.toMatchObject({ code: 'not_optimal' });
  }
  solver.solve.mockReset().mockReturnValue({ ...riskSolution, Columns: { q0: { Primal: NaN } } });
  await expect(solveTeacher(problem)).rejects.toMatchObject({ code: 'invalid_solution' });
  solver.solve.mockReset().mockImplementation(() => { throw new Error('native failure'); });
  await expect(solveTeacher(problem)).rejects.toMatchObject({ code: 'solver_failure' });
  solver.solve.mockReset().mockReturnValueOnce(riskSolution).mockReturnValue({ ...riskSolution, ObjectiveValue: 0 });
  expect((await solveTeacher(problem)).valuation.totalCostUsd).toBe('0');
});
