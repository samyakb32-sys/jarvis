# robot-heads (vendored)

The renderer of [fayazara/robot-heads](https://github.com/fayazara/robot-heads)
by Fayaz Ahmed, MIT licensed (see `LICENSE`), copied from commit
`58ebf6439a8125a769f63b22ffd35bc18834b1b5` (2026-10-10).

Copied unchanged: `tv/*.ts`, `color.ts`. `types.ts` keeps only the two state
and shape unions; the React component is not used. `../../mascot/robot.ts`
drives `RobotSim` and `RobotRenderer` directly, the same way upstream's
`RobotHead.tsx` does.
