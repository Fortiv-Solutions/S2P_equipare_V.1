import type { ModuleDef } from './types.ts';
import { module as pr } from './pr/index.ts';
import { module as rfq } from './rfq/index.ts';
import { module as cmp } from './cmp/index.ts';
import { module as approvals } from './approvals/index.ts';
import { module as contracts } from './contracts/index.ts';
import { module as po } from './po/index.ts';
import { module as asn } from './asn/index.ts';
import { module as vendors } from './vendors/index.ts';
import { module as invoices } from './invoices/index.ts';
import { module as payments } from './payments/index.ts';
import { module as sap } from './sap/index.ts';
import { module as reports } from './reports/index.ts';
import { module as admin } from './admin/index.ts';
import { module as insights } from './insights/index.ts';
import { module as home } from './home/index.ts';

export const MODULES: ModuleDef[] = [pr, rfq, cmp, approvals, contracts, po, asn, vendors, invoices, payments, sap, reports, admin, insights, home];
