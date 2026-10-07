export type Nav =
  | { kind: 'inbox' }
  | { kind: 'noise' }
  | { kind: 'project'; projectId: string }
  | { kind: 'people' }
  | { kind: 'activities' }
  | { kind: 'settings' };

export const sameNav = (a: Nav, b: Nav) =>
  a.kind === b.kind && (a.kind !== 'project' || (b.kind === 'project' && a.projectId === b.projectId));
