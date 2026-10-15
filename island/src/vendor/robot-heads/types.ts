// The two unions the renderer needs from upstream src/types.ts (the React
// props interface is left out: Jarvis Island drives the renderer directly).

/** What the robot is doing: each state has its own face, motion and antenna light. */
export type RobotHeadState =
  | 'idle'
  | 'thinking'
  | 'searching'
  | 'listening'
  | 'speaking'
  | 'working'
  | 'happy'
  | 'error'
  | 'sleeping';

/** The outline of the head, seen from the front. */
export type RobotHeadShape = 'rectangle' | 'square' | 'circle' | 'hexagon';
