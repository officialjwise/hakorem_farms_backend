/**
 * IAM's public door (MODULE_BOUNDARIES, IAM card). Higher modules import only from here: the policy engine every
 * handler calls, the maker-checker mechanism, and the ScopeNames port MDM implements.
 */
export { Authoriser, type AuthoriseScope } from './application/authoriser';
export { Approvals, type ApprovalHandler, type ApprovalRecord, type NewApproval } from './application/approvals';
export { ScopeNamesRegistry } from './application/authentication.service';
export type { ScopeNames } from './application/ports';
export { IamModule } from './iam.module';
