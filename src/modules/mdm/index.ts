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
 * B05 continued adds `MasterDataRefs`: products, locations, suppliers and grades by id in the caller's transaction,
 * the read side of `Catalogue`, `Parties` and `Locations` that inventory needs to post and show stock; B05 continued 2
 * adds branches, reasons from the fixed list and a branch's physical location of a kind (its in-transit location).
 */
export { MdmModule } from './mdm.module';
export { PricingService, type SellingProductView, type SellingUnitView, type SellingUnitsView, type AppliedPromotionView, type PriceResolutionView, type PriceResolveResultView, type ResolveLine, type ResolveRequest } from './application/pricing';
export { defaultLineUom } from './domain/pricing/selling-units';
export { extendPrice, judgeAgreedPrice, type AgreedPriceVerdict, type Channel, type PriceBasis, type QuoteRequiredReason } from './domain/pricing/pricing-engine';
export { TaxService, type TaxCalculation, type TaxLineRequest, type TaxRequest } from './application/tax-calculation';
export type { TaxCellView } from './application/tax-admin';
export type { CategoryTreatment, LevyLine, TaxBreakdown, TaxTotals, TaxTreatment } from './domain/tax/tax-calculator';
export { couponLockKey, Promotions, type CouponRedemptionRequest } from './application/promotions';
export type { PriceListVersionActivated, ProductArchived, ProductChanged, ProductCreated, SupplierRegistered, PromotionActivated, PromotionEnded, TaxSchemeVersionActivated } from './events';
export { PriceListAdmin, type PriceListDraft, type VersionDraft } from './application/price-lists';
export { TaxAdmin, type TaxCellRequest } from './application/tax-admin';
export type { PromotionCreateRequest } from './application/promotions';
export { CatalogueAdmin } from './application/catalogue-admin';
export { ProductCatalogue } from './application/product-catalogue';
export { UomConversions, type UomConversionView } from './application/uom-conversions';
export { exactFactor, factorText, fromBase, toBase, type UomFactor } from './domain/unit-conversion';
export { LocationsAdmin } from './application/locations-admin';
export { PartiesAdmin } from './application/parties-admin';
export { ReferenceDataAdmin } from './application/reference-data-admin';
export { MasterDataRefs, type ReasonCodeView, type ToBaseRefusal, type PaymentMethodFacts, type BranchFacts, type CustomerAddressFacts, type CustomerContactFacts, type CustomerFacts, type GradeFacts, type WeightBandFacts, type LocationFacts, type ProductFacts, type ReasonCodeFacts, type SpeciesFacts, type SupplierFacts, type TaxCategoryFacts, type UomFacts } from './application/master-data-refs';
/**
 * B05 continued 4 adds the import sheet port (ADR-0050): a higher module that owns an entity's rows implements
 * `EntitySheet` and registers it with `MdmImports.registerSheet` when it starts, as INV does for `OPENING_STOCK`; MDM
 * reads the file, runs the dry run and the all-or-none apply, and the sheet writes through its own module's services.
 */
export { MdmImports } from './application/imports';
export { cached, readRows, type EntitySheet, type SheetCheck, type SheetRecords } from './application/import-sheets';
export { duplicateErrors, type RowError, type SheetColumns } from './domain/imports';
/**
 * B05x adds the location usage port (ADR-0051): a higher module that holds stock or documents at a branch or location
 * implements `LocationUsageCheck` and registers it with `LocationUsageRegistry.register` when it starts, as INV does;
 * closing a branch and archiving a location ask every registered check in their transaction.
 */
export { LocationUsageRegistry, type LocationUsageCheck } from './application/location-usage';
export type { PlaceUsage } from './domain/locations';
/**
 * B07 continued 2 adds `Storefront`, the read side the online store needs in its own transaction: the products and
 * categories the public sees (never a cost, floor or ceiling), the delivery zone of an address, the delivery fee's tax
 * category and the weight bands a price range is read over.
 */
export { Storefront, type DeliveryZoneFacts, type OnlineCategoryFacts, type OnlineProductFacts } from './application/storefront';
