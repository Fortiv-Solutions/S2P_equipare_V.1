import { Router } from 'express';
import { z } from 'zod';
import type { ModuleDef } from '../types.ts';
import { all } from '../../core/db.ts';
import { h, parse, idParam, reasonSchema } from '../../core/http.ts';
import { requirePerm, actorOf } from '../../core/auth.ts';
import { registerConfig, seedConfig } from '../../core/config.ts';
import * as S from './service.ts';

const router = Router();

const userSchema = z.object({
  name: z.string().trim().min(2, 'Enter the full name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid e-mail address'),
  phone: z.string().trim().max(30).nullish(),
  title: z.string().trim().max(120).nullish(),
  department: z.string().trim().max(120).nullish(),
  roles: z.array(z.string()).optional(),
  plant_scope: z.union([z.literal('*'), z.array(z.string())]).optional(),
  categories: z.array(z.string()).optional(),
  manager_id: z.number().int().positive().nullish(),
  vendor_id: z.number().int().positive().nullish(),
  vendor_role: z.string().nullish(),
});

// ------------------------------------------------------------------ users & roles (SCR-ADM-01)
router.get('/users', requirePerm('adm.users'), h(() => S.listUsers()));
router.get('/users/meta', requirePerm('adm.users'), h(() => S.userMeta()));
router.post('/users', requirePerm('adm.users'), h((req) => S.createUser(actorOf(req), parse(userSchema, req.body))));
router.put('/users/:id', requirePerm('adm.users'), h((req) => S.updateUser(actorOf(req), idParam(req), parse(userSchema.partial().extend({ reason: z.string().trim().max(500).nullish() }), req.body))));
router.post('/users/:id/lock', requirePerm('adm.users'), h((req) => S.lockUser(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/users/:id/unlock', requirePerm('adm.users'), h((req) => S.unlockUser(actorOf(req), idParam(req), parse(z.object({ reason: z.string().trim().max(500).nullish() }), req.body).reason ?? null)));
router.post('/users/:id/deactivate', requirePerm('adm.users'), h((req) => S.deactivateUser(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/users/:id/reactivate', requirePerm('adm.users'), h((req) => S.reactivateUser(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.post('/users/:id/reset-password', requirePerm('adm.users'), h((req) => S.resetPassword(actorOf(req), idParam(req))));
router.post('/sod-check', requirePerm('adm.users'), h((req) => ({ warnings: S.sodWarnings(parse(z.object({ roles: z.array(z.string()) }), req.body).roles) })));

// ------------------------------------------------------------------ hub & configuration helpers
router.get('/summary', requirePerm('adm.users', 'adm.config', 'adm.masters'), h(() => S.adminSummary()));
router.get('/config/pending', requirePerm('adm.config', 'config.approve_tolerance', 'audit.view'), h(() => S.pendingConfig()));

// ------------------------------------------------------------------ masters (SCR-ADM-03)
const matrixSchema = z.object({
  category: z.string().min(1, 'Choose a category'), plant: z.string().min(1, 'Choose a plant'), priority_route: z.string().min(1),
  buyer_id: z.number({ error: 'Choose a buyer' }).int().positive('Choose a buyer'), backup_buyer_id: z.number().int().positive().nullish(), active: z.boolean(),
});
const categorySchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z]{2,6}$/, 'Code is 2 to 6 letters, e.g. HYD'), name: z.string().trim().min(2, 'Enter the category name').max(80),
  parent: z.string().nullish(), min_vendors: z.number({ error: 'Enter a number' }).int().min(1, 'At least 1 vendor').max(20, 'At most 20'),
  rfq_rule: z.string().max(200).nullish(), itc_recoverable: z.boolean(), description: z.string().max(300).nullish(),
});
const groupSchema = z.object({ material_group: z.string().trim().regex(/^[A-Za-z0-9-]{2,20}$/, 'Use the SAP material group code, e.g. HYD-SEAL'), category: z.string().min(1, 'Choose a category'), apply_to_materials: z.boolean().optional() });

router.get('/plants', requirePerm('adm.masters', 'adm.users'), h(() => all('SELECT * FROM plants ORDER BY code')));
router.get('/buyers', requirePerm('adm.masters'), h(() => all("SELECT id, name, categories FROM users WHERE active = 1 AND vendor_id IS NULL AND (',' || roles || ',') LIKE '%,BUY,%' ORDER BY name")));
router.get('/buyer-matrix', requirePerm('adm.masters'), h(() => S.buyerMatrix()));
router.post('/buyer-matrix', requirePerm('adm.masters'), h((req) => S.createMatrixRow(actorOf(req), parse(matrixSchema, req.body))));
router.put('/buyer-matrix/:id', requirePerm('adm.masters'), h((req) => S.updateMatrixRow(actorOf(req), idParam(req), parse(matrixSchema, req.body))));
router.post('/buyer-matrix/:id/delete', requirePerm('adm.masters'), h((req) => S.deleteMatrixRow(actorOf(req), idParam(req), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.get('/categories', requirePerm('adm.masters'), h(() => S.categories()));
router.post('/categories', requirePerm('adm.masters'), h((req) => S.saveCategory(actorOf(req), parse(categorySchema, req.body), true)));
router.put('/categories/:code', requirePerm('adm.masters'), h((req) => S.saveCategory(actorOf(req), { ...parse(categorySchema.omit({ code: true }), req.body), code: String(req.params.code) }, false)));
router.post('/categories/:code/delete', requirePerm('adm.masters'), h((req) => S.deleteCategory(actorOf(req), String(req.params.code), parse(z.object({ reason: reasonSchema }), req.body).reason)));
router.get('/material-groups', requirePerm('adm.masters'), h(() => S.materialGroups()));
router.post('/material-groups', requirePerm('adm.masters'), h((req) => S.saveMaterialGroup(actorOf(req), parse(groupSchema, req.body), true)));
router.put('/material-groups/:group', requirePerm('adm.masters'), h((req) => S.saveMaterialGroup(actorOf(req), { ...parse(groupSchema.omit({ material_group: true }), req.body), material_group: String(req.params.group) }, false)));
router.post('/material-groups/:group/delete', requirePerm('adm.masters'), h((req) => S.deleteMaterialGroup(actorOf(req), String(req.params.group), parse(z.object({ reason: reasonSchema }), req.body).reason)));

function init() {
  registerConfig({
    key: 'security.sod_conflicts', label: 'Segregation-of-duties role conflicts', group: 'Security',
    description: 'Role combinations warned when a user is given them (SCR-ADM-01). The approval engine still blocks approving one\'s own request.',
    value: [
      { roles: ['BUY', 'APR'], risk: 'Buyer who also approves can push their own recommendations through; the engine blocks self-approval but peers may approve each other.' },
      { roles: ['FIN', 'BUY'], risk: 'Same person can award a purchase and release or approve its payment.' },
      { roles: ['ADM', 'APR'], risk: 'Administrator can change routing rules and approve transactions (PRD Sec 6: admins never approve).' },
      { roles: ['ADM', 'FIN'], risk: 'Administrator can change tolerances and approve finance steps.' },
      { roles: ['STO', 'FIN'], risk: 'Same person can receive goods and approve the matching invoice.' },
    ],
    decision: 'Q Sec 6',
  });
  // Existing databases get settings registered after they were seeded.
  seedConfig(null);
}

export const module: ModuleDef = { path: 'admin', router, init };
