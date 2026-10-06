// Fonte ÚNICA dos papéis e códigos de permissão no app (espelho de supabase/migrations/…_permissions.sql; um teste garante que batem).
// A tela usa isto só para MOSTRAR/ESCONDER ações; quem decide é o banco (RLS/RPC). Nunca usar nome de usuário como regra.
'use strict';

const ROLES = Object.freeze({ MASTER: 'MASTER', ADMIN: 'ADMIN', USER: 'USER' });
const STATUS = Object.freeze({ INVITED: 'invited', PENDING: 'pending', ACTIVE: 'active', SUSPENDED: 'suspended' });

const PERMISSIONS = Object.freeze({
  PROJECTS_VIEW_ALL: 'projects.view_all',
  PROJECTS_EDIT_ALL: 'projects.edit_all',
  PROJECTS_CREATE: 'projects.create',
  CONFIG_CYCLES: 'config.cycles.manage',
  CONFIG_CHECKLISTS: 'config.checklists.manage',
  CONFIG_CATALOGS: 'config.catalogs.manage',
  CONFIG_COMMS: 'config.comms.manage',
  CONFIG_DOCUMENTS: 'config.documents.manage',
  CONFIG_SCRIPTS: 'config.scripts.manage',
  CONFIG_PEOPLE: 'config.people.manage',
  CONNECTIONS_MANAGE: 'connections.manage',
  USERS_MANAGE: 'users.manage',
  AUDIT_VIEW: 'audit.view',
  RELEASES_PUBLISH: 'releases.publish',
});

// Perfil vindo de public.my_profile(): { id, role, status, permissions[] }. Inativo nunca pode nada (fail closed).
function can(profile, code) {
  if (!profile || profile.status !== STATUS.ACTIVE) return false;
  if (profile.role === ROLES.MASTER) return true;
  return Array.isArray(profile.permissions) && profile.permissions.includes(code);
}

module.exports = { ROLES, STATUS, PERMISSIONS, can };
