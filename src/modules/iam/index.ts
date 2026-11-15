/**
 * IAM's public door (MODULE_BOUNDARIES, IAM card). Higher modules import only from here: the policy engine every
 * handler calls, the maker-checker mechanism, principal display names, and the ScopeNames port MDM implements.
 */
export { Authoriser, type AuthoriseScope } from './application/authoriser';
export type { GrantScope } from './domain/authorisation-policy';
export { Approvals, type ApprovalHandler, type ApprovalRecord, type NewApproval } from './application/approvals';
export { PRINCIPAL_NAMES, type PrincipalNames, type PrincipalRef } from './application/principal-names';
export { ScopeNamesRegistry } from './application/authentication.service';
export type { BranchRefRecord, LocationRefRecord, ScopeNames } from './application/ports';
export { AccessAdmin, type UserCreatedView } from './application/access-admin';
export { AuthenticationService } from './application/authentication.service';
export { IamModule } from './iam.module';
