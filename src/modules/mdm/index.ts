/**
 * MDM's public door (MODULE_BOUNDARIES, MDM card). Higher modules import only from here. B4 adds the pricing engine:
 * selling modules price a line with `PricingService.resolveIn` inside their own transaction (ADR-0004) and judge an
 * agreed price with `judgeAgreedPrice`. `Catalogue`, `Parties`, `Locations` and the tax calculator arrive with
 * B04 continued.
 */
export { MdmModule } from './mdm.module';
export { PricingService, type PriceResolutionView, type PriceResolveResultView, type ResolveLine, type ResolveRequest } from './application/pricing';
export { extendPrice, judgeAgreedPrice, type AgreedPriceVerdict, type Channel, type PriceBasis, type QuoteRequiredReason } from './domain/pricing-engine';
export type { PriceListVersionActivated, ProductCreated } from './events';
