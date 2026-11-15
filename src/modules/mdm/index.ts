/**
 * MDM's public door (MODULE_BOUNDARIES, MDM card). Higher modules import only from here. B4 adds the pricing engine:
 * selling modules price a line with `PricingService.resolveIn` inside their own transaction (ADR-0004) and judge an
 * agreed price with `judgeAgreedPrice`. B04 continued adds the tax calculator: quotes, carts, orders, billing and
 * purchasing tax their lines with `TaxService.calculateIn` inside their own transaction (ADR-0020). B04d adds
 * promotions: `resolveIn` returns each line's discounts, and a selling module redeems or releases a coupon with
 * `Promotions.redeemIn` and `releaseIn` in its transaction, holding `couponLockKey(code)` (ADR-0040). B04d continued
 * publishes the administration services so the seeded farm is written through them (A-085); no module calls them.
 * B04d continued 2 adds the branch, location and party administration for the seed on the same terms (ADR-0042).
 * B04d continued 3 adds suppliers and the reference data (payment methods, delivery zones) on the same terms.
 */
export { MdmModule } from './mdm.module';
export { PricingService, type AppliedPromotionView, type PriceResolutionView, type PriceResolveResultView, type ResolveLine, type ResolveRequest } from './application/pricing';
export { extendPrice, judgeAgreedPrice, type AgreedPriceVerdict, type Channel, type PriceBasis, type QuoteRequiredReason } from './domain/pricing/pricing-engine';
export { TaxService, type TaxCalculation, type TaxLineRequest, type TaxRequest } from './application/tax-calculation';
export type { CategoryTreatment, LevyLine, TaxBreakdown, TaxTotals, TaxTreatment } from './domain/tax/tax-calculator';
export { couponLockKey, Promotions, type CouponRedemptionRequest } from './application/promotions';
export type { PriceListVersionActivated, ProductArchived, ProductChanged, ProductCreated, SupplierRegistered, PromotionActivated, PromotionEnded, TaxSchemeVersionActivated } from './events';
export { PriceListAdmin, type PriceListDraft, type VersionDraft } from './application/price-lists';
export { TaxAdmin, type TaxCellRequest } from './application/tax-admin';
export type { PromotionCreateRequest } from './application/promotions';
export { CatalogueAdmin } from './application/catalogue-admin';
export { ProductCatalogue } from './application/product-catalogue';
export { LocationsAdmin } from './application/locations-admin';
export { PartiesAdmin } from './application/parties-admin';
export { ReferenceDataAdmin } from './application/reference-data-admin';
