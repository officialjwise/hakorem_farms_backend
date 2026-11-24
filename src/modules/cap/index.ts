/**
 * CAP's public door (MODULE_BOUNDARIES, CAP card). No other module imports CAP: it answers HTTP and posts through FIN.
 * The module and its services are exported for the application's wiring, the seed and the tests.
 */
export { CapModule } from './cap.module';
export { Capital, CAPITAL_CONTRIBUTED, CAPITAL_WITHDRAWAL, CAPITAL_WITHDRAWN, type CapitalTransactionView, type InvestorView } from './application/capital';
export { Distributions, DISTRIBUTION_DECLARED, DISTRIBUTION_PAID, INVESTOR_DISTRIBUTION, type DistributionRunView } from './application/distributions';
export { Financing, FINANCING, type FinancingView } from './application/financing';
export { InvestorPortal } from './application/investor-portal';
export { InvestorProfiles, INVESTOR_PAYOUT_CHANGE } from './application/investor-profiles';
export { InvestorReturns } from './application/investor-returns';
