/**
 * MDM's public door (MODULE_BOUNDARIES, MDM card). Higher modules import only from here. B4 adds the pricing engine:
 * selling modules price a line with `PricingService.resolveIn` inside their own transaction (ADR-0004) and judge an
 * agreed price with `judgeAgreedPrice`. B04 continued adds the tax calculator: quotes, carts, orders, billing and
 * purchasing tax their lines with `TaxService.calculateIn` inside their own transaction (ADR-0020).
 */
export { MdmModule } from './mdm.module';
export { PricingService, type PriceResolutionView, type PriceResolveResultView, type ResolveLine, type ResolveRequest } from './application/pricing';
export { extendPrice, judgeAgreedPrice, type AgreedPriceVerdict, type Channel, type PriceBasis, type QuoteRequiredReason } from './domain/pricing/pricing-engine';
export { TaxService, type TaxCalculation, type TaxLineRequest, type TaxRequest } from './application/tax-calculation';
export type { CategoryTreatment, LevyLine, TaxBreakdown, TaxTotals, TaxTreatment } from './domain/tax/tax-calculator';
export type { PriceListVersionActivated, ProductCreated, TaxSchemeVersionActivated } from './events';
