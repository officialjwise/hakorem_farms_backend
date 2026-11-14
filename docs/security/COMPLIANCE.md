# HaKorem Farms Platform: Compliance

What the law and the card schemes ask of this system and of the business that runs it, checked against official sources on **2026-11-13** (session B1). Every obligation carries the source, the date checked and a verification status. Nothing here is legal or tax advice: it is an engineering record of what the sources say and what the system does about it, for the accountant and the owner to confirm.

## 1. How to read this document

**Verification statuses**

| Status | Meaning |
| --- | --- |
| **Verified, primary** | The text was read from the publisher's own document (the Act, a regulator's guideline, the regulator's web page) on 2026-11-13 |
| **Verified, primary, partial** | The primary document was read but does not answer the whole question; the gap is stated |
| **Secondary only** | Read in a professional-firm or news summary that cites the law; the law's own text was not read. Treat as a lead, not a fact |
| **Not verified on 2026-11-13** | Could not be reached or confirmed. What was tried is written next to it |

Source ids (S1, S2, ...) refer to the register in section 12, which gives the exact URL, what was read and any caveat. No URL, section number or figure in this document was supplied from memory: each comes from a page or document opened on 2026-11-13. Search queries contained no personal or project-identifying detail.

**Three documents are scans.** The GRA VAT guideline for Act 1151 (S4), the Data Protection Commission fee schedule (S13) and the Electronic Transactions Act (S14) are image PDFs. They were read by optical character recognition and the fee schedule was also read by eye from the rendered page. Section numbers and figures quoted from them were checked against the text, but a reader relying on a figure for a payment should open the original.

## 2. Summary

| # | Obligation | Applies? | Status | What the system does about it |
| --- | --- | --- | --- | --- |
| 1 | Register with the Data Protection Commission before processing personal data (Act 843 sections 27, 53, 56) | Yes, from the first customer record | Verified, primary | A go-live gate, outside the code. Renewal every two years (section 50); notify changes within 14 days (section 55) |
| 2 | Data-subject rights: access, correction and deletion, objection, direct marketing consent (sections 32, 33, 35, 39 to 44) | Yes | Verified, primary | `aud.data_subject_request`; export file; per-subject key destruction; retained categories reported |
| 3 | VAT at 15 percent with NHIL 2.5 percent and GETFund 2.5 percent on one base, COVID-19 levy abolished, from 1 January 2026 (Act 1151) | Yes, if the business is a registered or registrable taxable person | Verified, primary (GRA) | ADR-0020 matrix; seeded standard rates; `tax.registered` |
| 4 | VAT registration threshold GHS 750,000 for goods; no threshold for services | The business's position is the accountant's question (section 6, open point a) | Verified, primary | `tax.registered` switch |
| 5 | Certified invoicing (E-VAT) for taxable persons | Yes if registered, subject to onboarding by GRA | Verified, primary, partial | Certified-total fields on `bil.billing_document`; an adapter is needed before B8 if the business is onboarded (section 8) |
| 6 | Keep tax records at least six years; destroy only with permission | Yes, if registered | Verified, primary (E-VAT guideline, Act 772); statute text of Act 915 and Act 1151 secondary only | 84-month policy, no destruction (`DATA_CLASSIFICATION.md`) |
| 7 | Card data: stay in PCI DSS SAQ A | Yes, if cards are accepted through a provider | Verified, primary (PCI SSC FAQ); the provider's own statement secondary only | Hosted page, no card data on the server |
| 8 | Electronic records and electronic receipts (Act 772) | Yes | Verified, primary | Archived bytes with hash; electronic retention six years |

## 3. Decisions of the owner, recorded 2026-11-13

These are the owner's decisions, entered here so that no later session reopens them.

**Decision D-1: the tax rates and structure in ADR-0020 are confirmed correct against the VAT Act 2025 regime.**

- VAT 15 percent, NHIL 2.5 percent, GETFund 2.5 percent, all on one base (the taxable value, net of the three taxes).
- No compounding. Each levy's base is the net amount, so `base_kind` is `NET` for all three and `mdm.tax_levy_base_component` has no rows in the seeded version.
- No COVID-19 levy. No `COVID19` row is seeded in `mdm.tax_levy`.
- The owner confirmed the rates. The sources read on 2026-11-13 agree with the decision, which closes assumption A-021:
  - the GRA VAT page and the GRA VAT guideline for Act 1151 give 15, 2.5 and 2.5 percent, a 20 percent combined rate, on the same taxable value, with the COVID-19 levy abolished (S1, S2, S4);
  - the GRA guideline's derivation for tax-inclusive prices gives the tax fraction as 20/120 (VAT 1/8, NHIL 1/48, GETFund 1/48 of the inclusive amount), which is the same split as the inclusive-price method in ADR-0020 (S4, appendix);
  - an EY alert of 12 January 2026 gives the same rates and the same non-compounding base for domestic supplies, and says NHIL and GETFund are now deductible as input tax (S6).
- The text of the VAT Act, 2025 itself (Act 1151) was not read: a search for it on parliament.gh and gra.gov.gh found the GRA's own guideline to the Act (S4) and the Act's page index on parliament.gh (S7), not a full text. The rates are therefore verified against the regulator's published guidance, not against the section of the Act. That is what the owner's confirmation rests on.
- Consequence for the system: none. ADR-0020's proposed seed for `LIVE_ANIMALS`, `RAW_PRODUCE`, `EGGS` and `FARM_INPUTS` (zero-rated) and for `PROCESSED_MEAT`, `OTHER_GOODS`, `DELIVERY_SERVICE` (standard) is not changed by D-1. Whether produce and animals are zero-rated or exempt remains A-020 for the accountant.
- GRA's guideline requires computer-generated invoices to show separate lines for VAT, NHIL and GETFund, and says the COVID-19 field on old invoices is to be ignored (S1, S4 section 15.6). `bil.billing_document_line_tax` carries one row per levy, which meets this.

## 4. Open points for the accountant

Two points were put to the owner on 2026-11-13 and passed to the accountant. Each states what the sources say and what the system does under each answer. Until the accountant answers, the seeded values stay as ADR-0020 proposes.

### Open point (a): is the business above the GHS 750,000 VAT registration threshold at all?

**What the sources say**

- For a supplier of taxable goods, the registration threshold is GHS 750,000 of taxable supplies in any twelve-month period, with forward-looking tests of GHS 375,000 in six months, GHS 187,500 in three months and GHS 62,500 in one month (S4 section 7.2; S1 for the 750,000 figure).
- There is no registration threshold for service providers: a service provider is registerable within thirty days of starting to supply (S4 section 7.1; S6 agrees).
- A business already registered stays registered, and keeps charging and filing, until the Commissioner-General deregisters it, even if it is below the threshold. A registered taxpayer verified as below the threshold files nil returns until deregistered; after deregistration it no longer charges or files (S4 sections 15.1, 15.4, 15.9).

**Consequence for the system**

| Answer | What changes |
| --- | --- |
| The business is above the threshold, or registered anyway | `tax.registered` is true from its effective date. ADR-0020 applies in full: levies charged on sales, reclaimable input levies posted to account 1400 |
| The business is below the threshold and not registered | `tax.registered` is false. No levy is charged on any sale and no input levy is reclaimable: every levy on a supplier invoice becomes part of the cost of what was bought (ADR-0020). Documents are then issued as plain receipts and invoices with no tax lines, and E-VAT does not apply |
| The business is registered but below the threshold, awaiting deregistration | `tax.registered` stays true. The setting follows the registration status the GRA recognises, not the business's turnover. Nil returns are an accountant task |
| The business registers or deregisters later | A new `platform.setting` row with a later `valid_from` (settings with legal effect are effective-dated). Past documents are untouched, because each stores the scheme version it used |

**A sub-question inside (a):** `DELIVERY_SERVICE` is seeded as a standard-rated service category. The sources say a service provider has no threshold. Whether a delivery charge made with a sale of goods is part of that supply of goods (and so inside the goods threshold) or a separate supply of services (which would make the business registerable at any turnover) is not answered by the sources read. It is the accountant's call and it decides whether `tax.registered` can be false at all. Under either answer the system's behaviour is the data above.

**Also relevant to (a):** the GRA's VAT withholding rule. An appointed withholding agent withholds 7 percent of the taxable value of local taxable supplies at the time of payment and issues a withholding VAT certificate; the supplier takes a credit for it (S4 section 12.1). If wholesale buyers include appointed agents, a customer's payment will arrive short by the withheld amount, with a certificate. The data model has an account 2310 for withholding tax payable and a `withholding_rate_percent` on distribution runs, but no payment treatment or receivable account for VAT withheld by a customer. This is a gap reported to the lead (it concerns B8 and B9a); it does not change the rates.

### Open point (b): do imported farm inputs still cascade where domestic supply does not?

**What the sources say**

- For domestic supplies the taxable value excludes NHIL and GETFund, so levies no longer cascade (S6; S4 section 6 and 15.3: "the VAT rate and the levies are imposed on the same taxable value").
- EY notes that "the cascading effect of GETFund levy and NHIL appears to subsist for import of goods", because the provision says the import taxable value should exclude the levies but the text does not (S6). This is one firm's reading of the Act, and the point where the secondary source is least reliable. The Act's import provisions were not read.
- Importers of taxable goods with an import VAT base above GHS 750,000 who are not VAT-registered pay an upfront 20 percent of customs value, recoverable on application within six months (S4 sections 9.1 to 9.5). EY reports the rate rising from 12.5 to 20 percent (S6).
- For imports the customs Bill of Entry and the receipt for the tax paid are the control documents for input tax credit (S5 section 7(6)).

**Consequence for the system**

If the accountant confirms that imports still cascade, it is data, not code (ADR-0020):

1. a new row in `mdm.tax_category`, for example `IMPORTED_INPUTS`, assigned to the products or charges that are imported;
2. in a new `mdm.tax_scheme_version`, rows in `mdm.tax_category_levy` for that category with `base_kind = 'NET_PLUS_LEVIES'` for VAT, and `mdm.tax_levy_base_component` rows adding NHIL and GETFund to VAT's base, with a lower `calc_order` for the levies than for VAT (the definition cannot be circular);
3. `is_reclaimable` set to false on any levy the accountant says cannot be recovered on imports, so that `pur.supplier_invoice_line_tax` snapshots it as cost, not as account 1400;
4. activation as a maker-checker action with step-up (accountant drafts, owner approves).

If the accountant confirms that imports do not cascade, nothing is added.

One limit, reported as a gap: nothing in the data model or backlog records a customs Bill of Entry, customs duty or landed cost. If the business imports directly (rather than buying from a local distributor, who has already paid the import taxes and invoices the business in the ordinary way), the import taxes are charged on the customs declaration, not on a supplier invoice, and PUR would need an import cost document. ADR-0020 itself notes that a levy charged per unit rather than as a percentage is not expressible. Both belong in `docs/BACKLOG.md` if the accountant says imports are material.

### Other tax questions already open

A-020 (zero-rated versus exempt for produce, live animals and eggs, which changes input recovery), A-022 (registration status, answered by open point a), A-023 (whether retail and online lists are tax-inclusive) and A-030 (tax withheld on distributions) remain with the accountant. This document adds nothing to them except that the inclusive-price derivation in S4 (appendix) matches ADR-0020.

## 5. Ghana Data Protection Act, 2012 (Act 843)

### 5.1 What was checked

The Act's full text was downloaded from the Data Protection Commission's documents page (S9 lists it; S8 is the PDF) and read. Section numbers below are from that text. The Commission's website says the Act is the law establishing it and lists a draft Data Protection Bill uploaded in November 2025 (S9); no source read on 2026-11-13 says that Bill has been enacted, so Act 843 is treated as in force. That is **not verified**: a later Act would change the section numbers.

### 5.2 Obligations and where the system meets them

| Obligation | Source | Status | System or business action |
| --- | --- | --- | --- |
| A data controller who intends to process personal data must register with the Commission (section 27(1)). A controller not registered shall not process personal data (section 53). Processing without registering is an offence: a fine of up to 250 penalty units or up to two years in prison, or both (section 56) | S8 | Verified, primary | The business registers before go-live and before any customer record is created. The Commission's registration page says the same and describes registration through its portal (S11, S12). Recorded as a launch gate in the checklist in section 13 |
| Registration is renewed every two years (section 50). Changes to registered particulars are notified within fourteen days (section 55) | S8 | Verified, primary | The Commission's page gives a renewal window of "three months" in one place and "six weeks" in another, and allows seven days after expiry (S11). **Not verified**: the exact window. The business diarises renewal six months before expiry. The 14-day duty applies when the registered particulars change (for example a new processor or purpose) |
| Fees by size of business, set by L.I. 2512 (2025): small controllers GH¢156, medium GH¢1,170, large GH¢2,340, with specialist industries GH¢5,000 (S13). The small band is annual turnover below GH¢90,000 and at most 50 staff or customers; medium is turnover above GH¢90,000 and below GH¢5 million, or up to 50 staff or customers not above 249 (S13) | S13 | Verified, primary (read from the rendered page) | Which band the business falls in is for the Commission to decide; the owner confirms the amount at registration (the Commission's registration line is on S11). The wording of the bands on the schedule is not fully clear, so no figure is relied on |
| Consent, or another ground, is needed to process personal data. The grounds include a contract with the data subject, a legal requirement, a statutory duty and the controller's legitimate interest (section 20) | S8 | Verified, primary | Orders and delivery rest on contract; accounting records on legal requirement; marketing on consent (below) |
| The data subject is told, before collection: what is collected, who is collecting, the purpose, whether supply is voluntary, the consequences of not supplying, the legal basis, the recipients and the right of access and correction (section 27(2)) | S8 | Verified, primary | A privacy notice on the storefront sign-up, checkout, quote form and at the counter. Content is a launch task for the frontend and the owner; the backend stores `mdm.customer.marketing_consent_at` and `shp.cart.recovery_consent` |
| Do not keep personal data longer than needed for the purpose, unless the law requires or authorises it, it is reasonably necessary for a lawful purpose, a contract requires it, or the subject consents. Destroy, delete or de-identify at the end of the retention period, in a way that prevents reconstruction (section 24) | S8 | Verified, primary | `aud.retention_policy`; periods in `docs/security/DATA_CLASSIFICATION.md` section 4.2. Ciphertext with a destroyed key meets "prevents reconstruction" |
| Take appropriate, reasonable technical and organisational measures against loss and unauthorised access; identify risks, keep safeguards verified and updated; follow generally accepted security practice (section 28) | S8 | Verified, primary | The whole of `docs/security/` |
| A processor acts only on authority and under a written contract that requires confidentiality and security (sections 29 and 30). A processor outside Ghana must comply with Ghana's laws (section 30(4)) | S8 | Verified, primary | The business signs written processing terms with the hosting provider, the payment provider, the SMS, WhatsApp and email providers and the error-tracking provider. These are contracts, not code. The Act's text contains no general bar on transfers abroad that was found by searching for "foreign", "abroad" and "outside Ghana" (only section 30(4) and a definition of "foreign data subject"). **Not verified** beyond that search: the Commission may have issued a direction on transfers that is not in the Act |
| Notify the Commission and the data subject of unauthorised access or acquisition as soon as reasonably practicable after discovery, restoring the integrity of the system (section 31) | S8 | Verified, primary | `docs/runbooks/incident-response.md` (B13) includes the notification step and the Commission's incident and breach report form (S9). There is no fixed number of hours in the Act, so the runbook's internal target is 72 hours from discovery |
| Direct marketing needs the subject's prior written consent and may be stopped at any time by written notice (section 40) | S8 | Verified, primary | Consent is dated; withdrawal and an SMS reply of STOP are honoured immediately (`ntf.opt_out`, kept as a hash so it survives deletion). Abandoned-cart recovery messages need `recovery_consent` |
| Special personal data (a child under parental control; religion, ethnic origin, health, sexual life, criminal behaviour and the like) is not processed unless the Act permits (section 37) | S8 | Verified, primary | The system collects none of these categories on purpose. Free-text fields (`quo.rfq.requirements`, delivery `directions`) are not for them. Staff health is not recorded |
| A decision significantly affecting a person that rests solely on automated processing can be objected to (section 41) | S8 | Verified, primary | The system's automatic credit hold and refund limit are rule-based and every one has a human override and is audited. They are not profiling |
| Tax-related processing is exempt from the Act where applying it would prejudice assessment or collection of tax (section 61), and disclosure required by law or court order is exempt from non-disclosure (section 66) | S8 | Verified, primary | Supplying records to the GRA is lawful; export of tax records to the GRA is audited like any export |

### 5.3 Data-subject rights relevant to export and deletion

| Right | Source and wording | System behaviour |
| --- | --- | --- |
| **Access.** A data subject who proves identity may ask a controller to confirm whether it holds their personal data, describe it, say who has or had access, and supply it in an intelligible form (sections 32 and 35). The controller must comply promptly and in any event within forty days of receipt (section 35(10)). Supplying a copy in permanent form discharges the duty (section 35(12)). A controller need not repeat an identical request at an unreasonable interval (section 35(13)) | S8 | `aud.data_subject_request` of kind `EXPORT`. `received_at` starts the clock, `due_by` is set to 30 days (inside the 40-day limit). Identity is verified and recorded (`identity_verified_by`) before any data is released. The export is a `CONFIDENTIAL` `platform.stored_file` delivered by a signed URL expiring in 15 minutes. Data about another individual is withheld or redacted unless that person consents or it is reasonable to disclose (section 35(4)). A reasonable fee may be charged (section 32(2)); the business sets it to zero |
| **Correction and deletion.** A data subject may ask a controller to correct or delete data that is inaccurate, irrelevant, excessive, out of date, incomplete, misleading or obtained unlawfully, or to destroy or delete a record it no longer has authority to keep (section 33(1)). The controller must comply or give credible evidence in support of the data (section 33(2)), tell each person to whom the data was disclosed (section 33(4)) and tell the subject what it did (section 33(5)). The Commission can order rectification, blocking, erasure or destruction on a complaint (section 44) | S8 | `aud.data_subject_request` of kind `DELETION` or `CORRECTION`. A deletion needs a second person's approval (maker-checker). It anonymises the customer master record and destroys the per-subject key (ADR-0022). The outcome lists `retained_categories` and tells the subject why. The business also records the processors to whom the data was disclosed (the payment, messaging and hosting providers), so it can send the notice in section 33(4); that list is kept in this document's section 5.4 |
| **Objection and stopping processing.** A data subject may object to processing (section 20(2)); by written notice may require a controller to stop or not begin processing likely to cause unwarranted damage or distress (section 39) | S8 | Treated as a request through the same table; the customer is blocked (`mdm.customer.status = 'BLOCKED'`) or anonymised as appropriate |
| **Marketing.** See section 40 above | S8 | `ntf.opt_out` |
| **Compensation.** A person who suffers damage from a breach of the Act can claim compensation (section 43) | S8 | Not a system function |

### 5.4 Processors the business must have a written contract with (section 29(2))

Hosting provider (servers), object storage provider (documents and encrypted backups), payment provider (first adapter Paystack, A-047), SMS and WhatsApp providers, email provider, error-tracking provider. The list is repeated in `docs/OPERATIONS.md` when each is chosen (A-067).

### 5.5 Retention versus deletion (assumption A-063)

See section 9. In short: section 24(1)(a) allows retention that is "required or authorised by law", and section 33(1)(b) concerns records the controller "no longer has the authorisation to retain". A tax record the law requires the business to keep is therefore outside a deletion request, and the outcome tells the subject so.

## 6. Ghana Revenue Authority: VAT and levies (VAT Act, 2025, Act 1151)

| Topic | What the sources say | Source | Status |
| --- | --- | --- | --- |
| Regime start | Act 1151 took effect on 1 January 2026, replacing the VAT Act, 2013 (Act 870) | S1, S4, S6 | Verified, primary (GRA) |
| Rates | VAT 15 percent; NHIL 2.5 percent; GETFund 2.5 percent; the 1 percent COVID-19 Health Recovery Levy is abolished | S1, S2, S4 | Verified, primary (GRA) |
| Base | VAT, NHIL and GETFund are imposed on the same taxable value. For tax-inclusive prices the tax fraction is 20/120, split VAT 1/8, NHIL 1/48, GETFund 1/48 (Act 1151 section 68 is cited by the guideline for inclusive prices) | S4 | Verified, primary (GRA) |
| Input tax | NHIL and GETFund are now deductible as input tax like VAT | S1, S6 | Verified, primary (GRA page); detail secondary |
| Flat rate scheme | The 3 percent and 5 percent flat rates are abolished; flat-rate taxpayers above the threshold convert to the standard rate | S1, S4 | Verified, primary |
| Registration | Goods: GHS 750,000 threshold. Services: no threshold. See open point (a) | S4 | Verified, primary |
| Returns and payment | Returns and payment by the last working day of the month after the period | S1; S4 section 15.4 says "on or before the last day of the month immediately following" | Verified, primary. The two GRA texts differ slightly ("last working day" and "last day"); the accountant files by the earlier |
| Invoice content | Computer-generated invoices must show separate lines for NHIL 2.5 percent, GETFund 2.5 percent and VAT 15 percent | S1 | Verified, primary |
| Tax invoice fields | Name, address and TIN (including the Ghana Card PIN) of the supplier; date and time; a consecutive invoice number; the customer's name, address and TIN; description, quantity and unit of measure; transaction type; levy rates and amounts; tax-exclusive charge per line; rate of tax; totals; rate of any discount; QR code, signature, verification engine id, time stamp. This list is from the 2024 E-VAT guideline, written under Act 870 and still listing the COVID-19 levy, which the Act 1151 guideline tells taxpayers to ignore | S5 section 7; S4 section 15.6 | Verified, primary. The 2024 list pre-dates the new Act; the accountant confirms nothing else changed |
| Customer TIN | For an individual the TIN includes the Ghana Card PIN; a sales receipt without the purchaser's name and TIN does not qualify the purchaser for input tax deduction | S5 | Verified, primary |
| Credit and debit notes | Cancelled or returned supplies are handled by cancelling the invoice and issuing a new one, or by a tax debit note once the return has been filed; credit and debit notes carry the original invoice number and TIN | S5 section 12.1, section 7(4) | Verified, primary |
| Discounts | Recognised only if non-discriminatory and available to every recipient; tax is on the discounted value | S5 section 12.3 | Verified, primary. A customer-specific price list is a pricing matter the accountant should review against this rule |
| VAT withholding | Appointed agents withhold 7 percent of taxable value on local taxable supplies at payment and issue a certificate; the supplier takes a credit | S4 section 12.1 | Verified, primary. Gap reported (section 4) |

**What the system does.** `tax.registered`, the scheme versions and the per-levy rows in `bil.billing_document_line_tax` implement the matrix (ADR-0020). The customer's TIN is captured where supplied (`mdm.customer.tin_enc`) and printed on the document (`bil.billing_document.customer_tin`). A returned or voided sale produces a credit note referencing the original document, not an edit.

## 7. Record retention for tax records

| Source | Statement | Status |
| --- | --- | --- |
| GRA E-VAT guideline GRA/AG/2024/005, section 13 (S5) | A registered person keeps a VAT account; accounting and business records including sales and purchase journals, cash books and ledgers; copies of all tax invoices and sales receipts issued and received; import and export documentation; tax debit and credit notes. "A registered person shall keep the records required to be kept under regulation 31(1) for a minimum period of six years and shall after the six years, only destroy the records with the written permission of the Commissioner-General as provided for in regulation 31(4)." Records may be kept electronically on application, with GRA given unrestricted access and printouts at the taxpayer's expense | Verified, primary (written under Act 870 and its Regulations L.I. 2243). **Not verified**: that regulation 31 carries over unchanged under Act 1151. The Act 1151 guideline (S4) does not state a period |
| Revenue Administration Act, 2016 (Act 915), section 27 | Taxable persons keep records of receipts and payments, revenue and expenditure, and assets and liabilities for at least six years from the relevant date, longer where a record stays relevant to an objection, appeal, refund or investigation | **Secondary only** (S15, S16). The Act's text was not read: a search found only unofficial copies, one of which redirected to an unrelated domain and was not opened |
| Electronic Transactions Act, 2008 (Act 772), section 8 | A legal duty to retain a record is met by electronic retention if the record is accessible, capable of retention, kept in the format generated or one shown to represent it accurately, and kept so that origin, destination, date and time can be identified. Section 8(2): "the document record or information shall be kept in electronic form for at least six years" | Verified, primary (official copy, S14, read by OCR) |
| Data Protection Act, 2012, section 24 | Retention beyond the purpose is allowed where the law requires it | Verified, primary (S8) |
| Companies Act and other statutes | Not checked on 2026-11-13. The business's lawyer or accountant confirms any longer period for company records | **Not verified on 2026-11-13**; no source was searched |

**Retention decision for the system.** Every record that supports a tax return (issued invoices, receipts, credit and debit notes, journals, payments, supplier invoices, stock movements, the archive and the audit log) is retained for 84 months from the record date, which is at least six years from the end of any year it relates to, and then archived offline rather than destroyed. Destruction happens only on a recorded written permission from the Commissioner-General. This is set in `aud.retention_policy` (`FINANCIAL_DOCUMENT`, `AUDIT_EVENT`) and is detailed in `docs/security/DATA_CLASSIFICATION.md`. The brief's five years online still applies.

## 8. GRA electronic invoicing (E-VAT)

| Question | What the sources say | Source | Status |
| --- | --- | --- | --- |
| What is it? | A certified invoicing system through which the GRA certifies invoices issued for accounting and VAT returns. It is "not a new tax, but an improvement in how VAT-able transactions are invoiced" | S5 section 1; S3 | Verified, primary |
| Does it apply? | The Act 1151 guideline (S4), issued 31 December 2025, says taxable persons "are required to issue a tax invoice or sales receipt to clients through the certified invoicing system of the Commissioner-General when they make taxable supplies" (section 8). The 2024 guideline covers all VAT-registered taxpayers, issued in phases "as determined by the Commissioner-General" (sections 6 and 16), onboarded by selection, request or at VAT registration | S4, S5 | Verified, primary. **Conclusion: yes if the business is a registered taxable person.** If it is not registered (open point a), no |
| When is a given business onboarded? | Phased. A 2024 notice onboarded a second wave of 2,000 registered taxpayers (S6a). The GRA's E-VAT page says a business requests the system at a Taxpayer Service Centre (S3). A report dated 29 October 2026 says E-VAT may extend to "Tier-2 medium enterprises" from 1 November 2026, but states that the scope was not confirmed by an official GRA announcement (S18) | S3, S5, S6a, S18 | Verified, primary for the process; the November 2026 extension is **secondary only and unconfirmed**. No 2026 GRA notice on E-VAT scope was found in searches on gra.gov.gh |
| Fiscal devices | A Fiscal and Accounting Devices Act was approved by Parliament in July 2026 according to the Commissioner-General, with implementation planned for the last quarter of 2026 (S17, article dated 15 September 2026). An EY alert says mandatory fiscal electronic device use is "to be implemented in 2026 in key sectors" (S6). A GRA page says fiscal electronic devices will be rolled out to support VAT-registered businesses (S2) | S2, S6, S17 | Verified, primary for the GRA statement that a rollout is coming; scope, deadlines and the relation to E-VAT are **not verified**: the news article does not say which businesses, and does not mention E-VAT. The Act's number and text were not found |
| How does a system integrate? | The taxpayer's own ERP or point-of-sale system integrates with the GRA system through an API; GRA supplies the API documentation, then tests and signs off, then schedules go-live. Alternatively GRA provides free invoicing software (desktop, Android, browser, one-off portal) | S5 sections 9 and 10 | Verified, primary |
| What is certified? | The certified invoice carries a QR code, an invoice signature, the verification engine id, encrypted data and a time stamp. Sales receipts may be printed or sent by SMS or email, with the same certification fields; a receipt without the buyer's name and TIN does not qualify for input tax | S5 sections 7 and 8 | Verified, primary |
| Offline | The GRA's E-VAT page says receipts can be generated "online or offline for up to 24 hours" (S3). The Act 1151 guideline says that if the taxpayer's certified invoicing system goes offline or becomes inaccessible to the Commissioner-General, the taxpayer must inform the Commissioner-General within 24 hours and restore it; transactions made while offline are uploaded when connectivity returns (S4 section 8) | S3, S4 | Verified, primary |

**What the system does and what changes if E-VAT applies.**

- `bil.billing_document` already has `certified_tax_pesewas`, `certified_gross_pesewas` and `certification_ref`, for the case where the certification service returns totals that differ by a pesewa from line sums (ADR-0020). Those columns can be filled without reworking the document pipeline, which is what the brief asks.
- If the accountant confirms the business is onboarded, a certification adapter port is needed in BIL. Certification is an external call, so it cannot run inside the sale's business transaction (ADR-0010), and the printed receipt must carry the QR code and signature the service returns. That sequence (issue, certify, render, print) is not in ADR-0015 or `docs/data-model/bil.md` today. It needs an ADR before B8, and the question of whether an offline counter can print a certified receipt belongs to it (A-061, section 10). The reportable gap is stated in the B1 report.
- Nothing in the code is to be built for E-VAT before the accountant answers open point (a) and, if registered, the GRA onboarding gives the API documentation. The sources say that documentation is what decides how tax is totalled on the certified document (A-062).

## 9. Open compliance assumptions: A-061, A-062, A-063

These three were open in `docs/ASSUMPTIONS.md` and assigned to B1. Their text there is not edited; the lead records the status. Each states what the sources say.

### A-061: a receipt printed offline with a provisional reference, followed by an official number at sync, is acceptable to the Ghana Revenue Authority (ADR-0015)

**Not confirmed by any source read.**

- No source mentions a provisional reference or a receipt number issued after the fact. Searches of the GRA's E-VAT page, the 2024 E-VAT guideline and the Act 1151 guideline found nothing on either (S3, S4, S5).
- What the sources do say is relevant: a tax invoice number must be "taken from a consecutive series" (S5 section 7(2)(c)); a taxpayer whose certified system is offline informs the GRA within 24 hours and uploads the offline transactions when connectivity returns (S4 section 8); the E-VAT software can generate receipts offline for up to 24 hours (S3); an invoice dated after the transaction may use both the transaction date and the invoice date (S5 section 17.1), which matches the separate `occurred_at` and `issue_date` on `bil.billing_document`.
- The 8-hour offline shift in the brief fits inside the 24-hour offline allowance. That helps but does not answer the question: the allowance is for the GRA's own software, and nothing says a different provisional receipt is an acceptable substitute.

**Position taken, and the consequence.** The assumption stays open. If the business is not a registered taxable person, the provisional receipt is an ordinary sales receipt and the official number follows by SMS or on reprint; no certification question arises. If the business is registered and onboarded, the offline receipt is the GRA's offline certified receipt and the provisional reference is not a substitute for it. The accountant, or the GRA relationship manager assigned at onboarding (S5 section 10), confirms this in writing. B9b does not build the print layout as final until that answer is in the UAT record.

### A-062: whether electronic invoice certification applies to this business, and whether it totals tax at document level

**Applies: yes if registered (section 8). Document-level totalling: not answered by the sources.**

- The Act 1151 guideline requires taxable persons to use the Commissioner-General's certified invoicing system (S4 section 8). So certification applies if the business is registered, subject to the GRA's phasing (S5 section 16). Open point (a) decides whether the business is registered.
- Neither guideline says whether the certification service computes tax per line, per levy or on the document total. The 2024 guideline lists "the tax-exclusive charge for each description", "the rate and corresponding amount of levies", "the total tax charged" and "the total charge inclusive of the tax" (S5 section 7(2)), which suggests per-line figures and document totals both appear, but does not describe the rounding. The API documentation the GRA gives at onboarding (S5 section 10(e)) is where this is answered. **Not verified on 2026-11-13**; the API documentation is not public in the sources reached.
- The system's position is unchanged: lines are the anchor, document totals are sums of line rows (ADR-0001), and the certified-total columns hold whatever the service returns, so a pesewa difference is recorded rather than hidden.

### A-063: the Data Protection Act permits retaining invoices and receipts for the statutory period despite a deletion request; the retention periods

**Supported by the Act. Periods supported at six years minimum.**

- Act 843 section 24(1)(a) allows a controller to keep a record where "the retention of the record is required or authorised by law", and section 24(4)(a) requires a record used to make a decision about a subject to be kept for the period the law requires. Section 33(1)(b) lets a subject ask for deletion of records the controller "no longer has the authorisation to retain", so a record the law requires the business to keep is outside that request (S8).
- Tax records must be kept at least six years (S5 section 13, regulation 31; S14 section 8(2); S15 and S16 for Act 915) and destroyed after that only with the Commissioner-General's written permission (S5 section 13).
- The decision in ADR-0022 (retain issued invoices and receipts with the details they were issued with, anonymise the master record, destroy the subject key) is consistent with those sources. The outcome to the subject lists `retained_categories` and gives the reason.
- **Not verified:** whether a longer period applies to any record category (company law, employment records). That was not searched. Whether the Commission has said anything specific about financial records and deletion requests was also not found.

## 10. Card data and PCI DSS

| Topic | What the sources say | Source | Status |
| --- | --- | --- | --- |
| Current standard | PCI DSS v4.0.1 is the current version on the Council's document library page; a summary of changes from v4.0 is published with it | S19 | Verified, primary |
| SAQ A | A merchant that outsources all card data functions to PCI DSS compliant third parties, never electronically storing, processing or transmitting card data, is eligible for the shortest questionnaire, SAQ A. The Council's FAQ 1588 (February 2025) and its announcement of 28 February 2025 describe the new eligibility criterion that applies from 1 April 2025: a merchant whose page embeds the processor's payment page or form (an iframe) must confirm its site is not susceptible to scripts that could affect the payment page. The criterion does not apply to a page that redirects the customer to the processor (an HTTP 30x, a meta refresh or a JavaScript redirect), nor to a merchant that fully outsources payment, for example by emailing a payment link | S20, S21 | Verified, primary. The SAQ A questionnaire itself is not listed in the document library page as fetched (it is loaded dynamically), so its full eligibility text was **not verified** on 2026-11-13 |
| SAQ A-EP | A merchant that builds the payment form on its own page and posts directly to the processor is outside SAQ A and in SAQ A-EP | Secondary summaries of the Council's SAQ guidance | **Secondary only** |
| The provider | A search snippet quotes the payment provider as audited by a PCI QSA as a Level 1 service provider, and one third-party guide says merchants using its checkout (popup, redirect or inline) fall under SAQ A. The provider's compliance page returned an access error and could not be opened | Search result only | **Not verified on 2026-11-13**. Tried: the provider's Ghana compliance page (HTTP 403). The business requests the provider's attestation of compliance and confirms its SAQ A eligibility in writing before go-live |

**What the system does.** No card number, expiry date or security code is stored, logged or passed through the server (`DATA_CLASSIFICATION.md` section 3, ADR-0022). Online card and mobile money payments use the provider's hosted page or tokenised flow. The server sees a reference, an amount and a status.

**Rules that follow from the sources.**

1. Prefer the redirect to the provider's hosted page. It keeps the business outside the script criterion.
2. If the storefront embeds the provider's payment form in an iframe or popup, the storefront keeps the Content Security Policy without `unsafe-inline` and `unsafe-eval` and explicit script sources (SECURITY_ARCHITECTURE section 5), and the owner obtains the provider's written confirmation that its embedded solution, used as instructed, protects against script attacks.
3. The owner completes and keeps the annual SAQ A attestation, and confirms with the acquirer (through the provider) that SAQ A is the questionnaire required. The Council's own guidance tells merchants to confirm with their acquirer or payment brands (S21).
4. Mobile money is not a card payment and is outside PCI DSS, but the same rule holds: the system never takes a wallet PIN.

## 11. Electronic transactions and receipts (Electronic Transactions Act, 2008, Act 772)

| Topic | What the Act says (official copy, S14, read by OCR) | System behaviour |
| --- | --- | --- |
| Writing | Where a law requires information to be in writing, an electronic form satisfies it if it is accessible and capable of being retained for later reference (section 5) | Invoices, receipts, quotes and statements are rendered documents archived in `doc.archived_document` |
| Original | Where a law requires information to be presented or retained in its original form, an electronic record satisfies it if there is reliable assurance of its integrity and it can be displayed; integrity means complete and unaltered (section 6) | The archive stores the bytes and their SHA-256 (`content_hash`); issued documents are frozen; a reprint is the same bytes with a marker |
| Evidence | An electronic record is not inadmissible only because it is electronic; weight depends on how it was generated, stored, kept intact and attributed (section 7) | The audit log, the hash chain and the signed anchors (ADR-0006) are the evidence of integrity and origin |
| Retention | See section 7: kept in electronic form for at least six years (section 8(2)) | 84-month retention |
| Signature | Where a law requires a signature, a digital signature satisfies it (section 10). Commentators note the Act uses "digital signature" for this and does not define an ordinary electronic signature | Delivery signatures and quote acceptance by signed link are evidence of consent, recorded with address and time. Whether they satisfy a statute that requires a signature is a legal question the system does not rely on |
| Reform | A draft Electronic Transactions Bill, 2025 was published for consultation by the National Information Technology Agency | **Secondary only**; not read. Act 772 is treated as in force |

Receipts sent by SMS or email are permitted for sales receipts by the GRA's E-VAT guideline, where the Commissioner-General permits sales receipts and the certified system is used (S5 section 8). The Act 772 position is consistent: an electronic form meets a writing requirement.

## 12. Source register

All sources were opened on **2026-11-13**. "Opened" means the page or file was fetched in full or in the part stated.

| ID | Source | URL | What was read | Status and caveat |
| --- | --- | --- | --- | --- |
| S1 | Ghana Revenue Authority, VAT page | https://gra.gov.gh/domestic-tax/tax-types/vat/ | Rates, threshold, flat-rate scheme, return dates, invoice levy lines | Verified, primary. Undated; footer 2025 |
| S2 | Ghana Revenue Authority, "VAT" page | https://gra.gov.gh/?p=14078 | Rates, same base, COVID-19 levy abolished, threshold, invoices, fiscal electronic devices to be rolled out | Verified, primary. Undated; footer 2025 |
| S3 | Ghana Revenue Authority, E-VAT service page | https://gra.gov.gh/e-services/e-vat/ | What E-VAT is, request through a Taxpayer Service Centre, offline receipts for 24 hours, 20 percent effective rate | Verified, primary. The page's download link names Act 1082 while its text names Act 1151; unexplained |
| S4 | GRA, VAT Administrative Guidelines for the Value Added Tax Act, 2025 (Act 1151), GRA/AG/25/002, issued 31 December 2025 | https://gra.gov.gh/wp-content/uploads/2026/01/VAT-Guidelines-for-VAT-ACT-1151.pdf | 22 pages: rate and computation, thresholds, invoice and system downtime, upfront payment, withholding, transitional provisions, tax fraction appendix | Verified, primary. Image PDF read by OCR. Found through a web search result, not through a link on gra.gov.gh pages |
| S5 | GRA, Guidelines on Certified Invoicing System (E-VAT), GRA/AG/2024/005, issued 18 June 2024 | https://gra.gov.gh/wp-content/uploads/2024/07/E-VAT-GUIDELINES_20240222.pdf | Scope, tax invoice and sales receipt fields, system types, onboarding, downtime, cancellations, record keeping | Verified, primary. Written under Act 870 and its amendments; lists the COVID-19 levy; its sections are numbered 1.0 to 21.0 and some were quoted from the contents list |
| S6 | EY Global Tax Alert, "Ghana's Parliament enacts several indirect-tax-related laws effective 1 January 2026", 12 January 2026 | https://taxnews.ey.com/news/2026-0163-ghanas-parliament-enacts-several-indirect-tax-related-laws-effective-1-january-2026 | Rates, base, input tax, thresholds, imports, fiscal devices, upfront payment | Secondary only. A professional firm's reading of the Act |
| S6a | GRA public notice, "Implementation of electronic invoicing of value added tax: phase two", 4 September 2024 | https://gra.gov.gh/implementation-of-electronic-invoicing-of-value-added-tax-phase-two/ | Second wave of 2,000 registered taxpayers | Verified, primary. Only the first 100,000 characters of the page were read |
| S7 | Parliament of Ghana, home page, Acts and Bills sections | https://www.parliament.gh | Menu links only (the Acts index at https://www.parliament.gh/docs?type=Acts&OT) | The Act 1151 text was **not found**: the index was not searched further |
| S8 | Data Protection Act, 2012 (Act 843), full text | https://dpc.gov.gh/wp-content/uploads/2025/05/data-protection-act-2012-act-843.pdf | Sections 17 to 35, 37, 39 to 44, 46 to 58, 61, 66, read from extracted text | Verified, primary. The PDF's metadata shows it was created in 2014; no amendments to Act 843 were found in the sources read |
| S9 | Data Protection Commission, documents page | https://dpc.gov.gh/documents/ | List of downloads including the Act, a draft Data Protection Bill (November 2025), the incident and breach report form and the fee schedule | Verified, primary. The draft Bill was not read |
| S10 | Data Protection Commission, individuals page | https://dpc.gov.gh/for-individuals/ | Describes the data subject's rights as "sections 39 through 44" and gives no response time | Verified, primary. The page's grouping of sections is looser than the Act's own numbering (access is sections 32 and 35); the Act text (S8) is followed |
| S11 | Data Protection Commission, registration page | https://dpc.gov.gh/registration/ | Who registers, section 53 and 56, process, renewal window, fees by sector | Verified, primary. Gives both "three months" and "six weeks" for the renewal window; no fee amounts. The old domain https://dataprotection.org.gh was a maintenance notice pointing to dpc.gov.gh and gave nothing |
| S12 | Data Protection Commission, home page | https://dpc.gov.gh | Registration and renewal portal links | Verified, primary |
| S13 | Fees and Charges (Miscellaneous Provisions) (Amendment) Regulations, 2025, L.I. 2512, Data Protection Commission schedule | https://dpc.gov.gh/wp-content/uploads/2026/02/DPC-NEW-FEES.pdf | Registration fee bands | Verified, primary, image PDF read from the rendered pages. The band wording is ambiguous in places |
| S14 | Electronic Transactions Act, 2008 (Act 772), official copy | https://csa.gov.gh/resources/Electronic%20Transactions%20Act.pdf | Sections 5 to 10 | Verified, primary. Scanned copy read by OCR; section 8(2) read as "at least six years". Later amendments (Act 838 of 2012 is mentioned by a secondary source) were not read |
| S15 | TaxLawGH (MSL Business School), taxpayer record keeping | https://www.taxlawgh.com/ghana-taxpayer-rights-record-keeping | Act 915 section 27, six years, longer where relevant to objection or appeal | Secondary only. Page marked "reviewed 24 July 2026" |
| S16 | Fiscal Requirements, "How long do taxpayers in Ghana have to keep records", 18 August 2023 | https://www.fiscal-requirements.com/news/2464-how-long-do-taxpayers-in-ghana-have-to-keep-records-and-what-are-the-penalties-for-non-compliance | Act 915, six years from the end of the year | Secondary only, older |
| S17 | MyJoyOnline, "GRA to roll out fiscal and accounting devices in Q4 to improve VAT compliance", 15 September 2026 | https://www.myjoyonline.com/gra-to-roll-out-fiscal-and-accounting-devices-in-q4-to-improve-vat-compliance/ | Fiscal and Accounting Devices Act approved in July; implementation in the last quarter of 2026 | Secondary only (a news report quoting the Commissioner-General) |
| S18 | Fiscal Requirements, "Ghana clarifies digital VAT collection rules as further E-VAT expansion is reported for November 2026", 29 October 2026 | https://www.fiscal-requirements.com/news/6142-ghana-clarifies-digital-vat-collection-rules-as-further-e-vat-expansion-is-reported-for-november-2026 | Reported expansion to Tier-2 medium enterprises from 1 November 2026, expressly unconfirmed | Secondary only, unconfirmed |
| S19 | PCI Security Standards Council, document library | https://www.pcisecuritystandards.org/document_library/ | PCI DSS v4.0.1 listed as the featured standard | Verified, primary. The SAQ documents are loaded dynamically and were not visible |
| S20 | PCI SSC, FAQ 1588, February 2025 | https://www.pcisecuritystandards.org/faqs/1588/ | SAQ A script criterion, iframe against redirect | Verified, primary |
| S21 | PCI SSC blog, "FAQ clarifies new SAQ A eligibility criteria for e-commerce merchants", 28 February 2025 | https://blog.pcisecuritystandards.org/faq-clarifies-new-saq-a-eligibility-criteria-for-e-commerce-merchants | Effective 1 April 2025, redirect and full outsourcing exempt, confirm with the acquirer | Verified, primary |

**Attempts that did not succeed**

| Tried | Result |
| --- | --- |
| The Act 1151 full text on gra.gov.gh and parliament.gh | Not found. The GRA's guideline to the Act (S4) was used instead |
| The Revenue Administration Act, 2016 text | An unofficial copy redirected to an unrelated domain and was not opened; GhaLII returned HTTP 403; judy.legal showed only sections 1 and 2 without signing in |
| The VAT Regulations, 2016 (L.I. 2243) | Not fetched; cited only as quoted in S5 |
| GRA notices on E-VAT scope in 2026 | A search limited to gra.gov.gh returned the 2024 guideline and the 2024 phase-two notice only |
| The Paystack compliance page (card scheme level, SAQ) | HTTP 403. Only a search snippet and third-party guides were seen |
| VATupdate articles on mandatory electronic receipts | HTTP 403 |
| The draft Data Protection Bill, 2025 | Listed on S9 but not read |
| The SAQ A questionnaire | The document library did not list it as fetched |

## 13. Launch checklist drawn from this document

None of these is code. Each has an owner and must be ticked in the UAT record before production.

| Item | Owner | Section |
| --- | --- | --- |
| Register with the Data Protection Commission, pay the fee for the band the Commission assigns, diarise renewal | Owner | 5.2 |
| Written processing terms with each processor | Owner | 5.4 |
| Privacy notice and marketing consent wording live on storefront, quote form and counter | Owner and frontend | 5.2 |
| Accountant answers open points (a) and (b) and A-020, A-022, A-023 | Accountant | 4 |
| If registered: GRA E-VAT onboarding, API documentation received, ADR for certification written before B8 | Accountant and backend | 8 |
| Written answer from GRA or the tax adviser on provisional offline receipts | Accountant | 9 (A-061) |
| Provider attestation of PCI compliance obtained; annual SAQ A attestation set up | Owner | 10 |
| Retention policy rows loaded from the periods in `DATA_CLASSIFICATION.md`; restore drill re-applies erasures | Backend | 7, DATA_CLASSIFICATION L-2 |
| Breach notification step and the Commission's incident report form in the incident response runbook | Backend and owner | 5.2 |
