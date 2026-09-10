import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Marks a route as restricted to one or more roles. Always paired with
 * RolesGuard — RBAC must be enforced server-side, never assumed from what a
 * front end chooses to render (see architecture doc §8).
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
