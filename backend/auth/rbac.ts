export type Role = 'admin' | 'operator' | 'viewer';

export interface Permission {
  read: boolean;
  write: boolean;
  delete: boolean;
}

export const ROLE_PERMISSIONS: Record<Role, Permission> = {
  admin: { read: true, write: true, delete: true },
  operator: { read: true, write: true, delete: false },
  viewer: { read: true, write: false, delete: false }
};

export function hasPermission(role: Role, action: 'read' | 'write' | 'delete'): boolean {
  const permission = ROLE_PERMISSIONS[role];
  return permission[action];
}

export function validateRole(role: string): Role {
  if (!['admin', 'operator', 'viewer'].includes(role)) {
    throw new Error('Invalid role');
  }
  return role as Role;
}