# HaKorem Farms Platform: User Acceptance Script

For the owner. Seven scripted days in the life of the farm, each of which you can run yourself, with a calculator and the people who work for you, and no developer beside you. If you cannot finish one of them without asking a developer what to do next, the system is not finished, and that is the result to write down.

Written 2026-11-13 in backend session B1 from the seven "System acceptance scenarios" in `docs/SHARED_BRIEF.md`. The figures are worked out by hand from the rules in the architecture decisions, so a wrong number on your screen is a finding, not a typing slip. The script is run before launch (session B13) on the staging server, and again after any big change.

## Contents

1. How to use this script
2. Who does what
3. Starting facts
4. Words used in this script
5. Scenario 1: a full trading day
6. Scenario 2: quote to cash
7. Scenario 3: traceability
8. Scenario 4: investor distribution
9. Scenario 5: fraud attempts
10. Scenario 6: offline counter
11. Scenario 7: disaster recovery
12. Sign-off

## 1. How to use this script

**Where.** On the staging server, never on the live farm. Staging is a copy of the system with test money, test mobile money numbers and test text messages. Nothing you do there is real.

**Before every scenario.** Ask the administrator to put staging back to the starting facts in section 3. Each scenario assumes a clean day: nothing else has been traded on staging that day. This is what lets the end-of-day totals be exact. Scenario 3 is the exception: it follows scenario 1 on the same data.

**While you run it.**

- Do the steps in order. Do not skip ahead.
- Each step has "Do this" and "You should see". Compare every number with the figure in the table, to the pesewa. A pesewa is one hundredth of a cedi; GHS 12.34 is 1,234 pesewas.
- Write **Pass** or **Fail** in the last column. A step passes only if everything in "You should see" is true.
- When a step fails, do not fix it and do not carry on to hide it. Take a screenshot (or photograph the screen), note the document number on screen, write what you saw next to what you should have seen, then carry on if you can.
- Anything the screen tells you in red, with a long code starting with a letter and numbers, is a correlation reference. Write it down; it is how the developer finds the exact request.

**At the end of each scenario** there is a result table. Fill in one row per checkpoint: Pass or Fail, the date, your name, and where the evidence is (a screenshot file name, or a document number such as `RCP-2026-DDW-T1-018834`).

**A note on numbers.** Amounts with a **GHS** prefix are cedis. The system stores and calculates in pesewas, whole numbers only, so it never produces fractions of a pesewa. When a total cannot be split evenly (for example a tax amount), the system gives the leftover pesewa to the part with the biggest remainder, and the parts always add up to the whole. Where this matters the script says so.

## 2. Who does what

Ask the administrator for a login for each person. Ask them to confirm that each login is for staging.

| Person | Role in the system | Used in |
| --- | --- | --- |
| Akua Mensah | Owner | 4, 5, 7 |
| Kwabena Owusu | Manager (also approves as supervisor) | 1, 2, 5, 6 |
| Efua Asante | Accountant | 1, 2, 4, 5, 7 |
| Yaw Boateng | Storekeeper | 1, 2, 5 |
| Adwoa Darko | Cashier at shop till T1 | 1, 5, 6 |
| Nana Yeboah | Cashier at shop till T2 | 5, 6 |
| Kojo Antwi | Sales and account manager | 2, 5 |
| Kwesi Appiah | Driver | 1, 5 |
| Emmanuel Tetteh | Customer C-00241 (has a login and a phone) | 2 |
| Ama Serwaa Ofori | Online customer (has a login and a phone) | 1, 5 |
| Ama Owusu-Ansah, Kofi Ampofo, Esi Bonsu, Yaw Frimpong, Akwaaba Diaspora Agro Fund | Investors (the first, second and fifth have portal logins; Yaw Frimpong does not) | 4, 5 |
| The administrator | The only technical person. Needed for the few steps marked **Administrator** | 5, 6, 7 |

You can play several customers yourself. A tester may play Emmanuel Tetteh or Ama Serwaa Ofori on their own phone.

Each person must be a different real person, or at least a different login on a different device, whenever the script says "a different person". Two logins that you control are fine; one login is not.

## 3. Starting facts

The administrator loads these into staging before each scenario. They come from the farm used in the API contract (`contract/openapi.yaml`, version 1.0.0), so the screens on staging and the documents agree. The seed script is extended every session, and these facts must stay true.

### 3.1 The business

- Branch: **HaKorem Farms, Dodowa** (code DDW). Tills **T1** and **T2** (shop floor). Time zone Africa/Accra.
- Locations: goat pens PEN-G1, PEN-G2, PEN-G3; poultry house PEN-B1; processing room PROC-1; cold room COLD-1; feed and produce store STORE-1; shop floor SHOP.
- Payment methods: Cash, and Mobile money (MoMo; on staging, the test number the administrator gives you).
- Opening float for a shift: GHS 200.00.
- Tax (confirmed by the owner on 2026-11-13): VAT 15 percent, NHIL 2.5 percent and GETFund 2.5 percent, all on the same base, none compounding. Live animals, produce and eggs are charged at zero percent (zero-rated). Processed meat and delivery are standard-rated. Counter and online prices include tax.

### 3.2 Goats and prices

| Tag | Where | Weight | Band | Cost to the farm | Notes |
| --- | --- | --- | --- | --- | --- |
| G-0142 | PEN-G1 | 26.400 kg | GOAT-M | GHS 612.50 | For sale |
| G-0157 | PEN-G1 | 31.800 kg | GOAT-L | GHS 748.00 | For sale |
| G-0171 | PEN-G2 | 24.900 kg | GOAT-M | GHS 589.00 | For sale |
| G-0175 | PEN-G1 | 24.100 kg | GOAT-M | GHS 570.00 | For processing. Bought from Kpone Livestock Traders (purchase GHS 450.00, feed GHS 90.00, veterinary GHS 30.00; dewormed with Albendazole 10% oral on 22 October, 14-day withdrawal period already over) |
| G-0163 | PEN-G2 | 22.150 kg | GOAT-M | GHS 523.00 | Under a veterinary withdrawal period until 28 November. Cannot be sold |
| G-0201 to G-0224 | PEN-G3 | each between 22.000 and 27.500 kg | GOAT-M | GHS 660.00 each | Twenty-four goats for sale |

Goat prices are per head and depend on the weight band. Counter prices, with floor (lowest allowed without approval) and ceiling (highest allowed):

| Product | List price | Floor | Ceiling |
| --- | --- | --- | --- |
| Goat, GOAT-S (10 to 18 kg) | GHS 450.00 | GHS 320.00 | GHS 520.00 |
| Goat, GOAT-M (18 to 28 kg) | GHS 850.00 | GHS 700.00 | GHS 980.00 |
| Goat, GOAT-L (28 to 45 kg) | GHS 1,400.00 | GHS 1,200.00 | GHS 1,950.00 |
| Beef, 15 kg pack | GHS 30.00 per kg | GHS 22.00 | GHS 43.33 |
| Full chicken, 15 kg pack | GHS 20.00 per kg | GHS 14.67 | GHS 23.33 |
| Goat meat | GHS 39.00 per kg | GHS 28.00 | GHS 55.00 |
| Eggs, big, crate of 30 | GHS 60.00 per crate | GHS 60.00 | GHS 60.00 |

Online prices are the same as counter prices. Royal Palm Hotel has its own contract list, in which a GOAT-M goat costs GHS 850.00 before tax.

### 3.3 Other stock

| Stock | Quantity at the start |
| --- | --- |
| Beef lot MEAT-BEEF-261104-01 | 88.200 kg |
| Chicken lot MEAT-CHK-261106-02 | 142.800 kg |
| Goat meat lot MEAT-GOAT-261109-01 (from goat G-0118) | 58.350 kg |
| Eggs, crate of 30, lot EGG-261112-L1 | exactly 40 crates |
| Oxytetracycline 20% injection, 100 ml, in STORE-1 | 10 units, GHS 85.00 each |
| Broiler chicken, lot BRL-2610-01 | 462 head |

Goats G-0206 to G-0209 and G-0204 and G-0205 are also in PEN-G3 and are part of the twenty-four. An approved purchase order is open with **Awutu Poultry Farm** (S-0019) for 20 broiler chickens at GHS 52.00 each, GHS 1,040.00 in all.

### 3.4 Customers

| Customer | Facts |
| --- | --- |
| Emmanuel Tetteh, C-00241 | Retail customer from Kasoa, mobile +233268114590. Account credit limit GHS 9,000.00, 30-day payment terms, no unpaid invoices |
| Royal Palm Hotel Ltd, C-00042 | Wholesale. Credit limit GHS 20,000.00, 30-day terms, unpaid invoices of GHS 11,644.00 and none of them overdue |
| Ama Serwaa Ofori | Online customer. House 14, Ashaley Botwe Road, Madina; digital address GM-091-4471; mobile +233244512876 |

Delivery zone ACC-EAST (Madina, Adenta, East Legon): GHS 30.00 delivery fee, free when the order is over GHS 500.00, tax included.

### 3.5 Investors and the capital register

One unit costs GHS 100.00. Units and the dates they take effect (the day of the contribution counts):

| No | Investor | Units | Effective date |
| --- | --- | --- | --- |
| INV-001 | Ama Owusu-Ansah | 1,000 | 1 June 2025 |
| INV-002 | Kofi Ampofo | 500 | 15 August 2026 |
| INV-003 | Esi Bonsu | 250 and 250 | 1 June 2025 and 1 September 2026 |
| INV-004 | Yaw Frimpong | 200 | 1 November 2025 |
| INV-005 | Akwaaba Diaspora Agro Fund | 2,000 | 15 July 2026 |
| | Total | 4,200 units | GHS 420,000.00 paid in |

The ledger for July, August and September 2026 is loaded so that income less cost of sales less expenses for those three months is **GHS 41,666.70**. The retention rate is 40 percent. Tax withheld on distributions is 0 percent.

### 3.6 Approval limits this script assumes

These are the starting limits (assumption A-043 in `docs/ASSUMPTIONS.md`: the owner sets the real ones before launch). If you change a limit, change the amounts in scenario 5 to match; do not change the limit to fit the script.

| Rule | Limit used here |
| --- | --- |
| A death or cull above this value needs a photograph and a second person | GHS 300.00 |
| A stock adjustment above this value needs a second person | GHS 200.00 |
| A refund above this value needs a second person | GHS 100.00 |
| A cashier's own price change on one line | up to 10 percent below the list price |
| A cashier's total price changes in one shift | up to GHS 100.00 |
| A quote below this margin needs a second person | 20 percent |
| A void of a completed sale | always needs a supervisor who is not the cashier |
| A credit order over the credit limit | always needs a second person |

## 4. Words used in this script

- **Shift**: one cashier's working period on one till, from counting the opening float to counting the cash at the end.
- **Float**: the cash the till starts with so the cashier can give change.
- **Blind close**: the cashier counts the till and types in the amount without being shown what the system expects. The system compares afterwards.
- **Cash drop**: taking cash from the till to the safe during the day.
- **X report**: a reading of the shift so far. It does not close anything.
- **Z report**: the final report when a shift is closed. There is only ever one.
- **Tender**: one way of paying. A sale paid partly in cash and partly by mobile money has two tenders.
- **Catch weight**: meat sold by weight where the final price is only known when it is weighed. The order shows an estimate, an upper limit, and the final amount is based on what the scale says.
- **Lot**: a quantity of stock produced or received together, with its own number. **Pack**: one labelled, weighed piece of a lot.
- **Hold**: a block on selling something, for example a goat under a veterinary withdrawal period.
- **Reservation**: stock set aside for a quote or an order so nobody else can sell it.
- **Journal**: the accounting record of a sale, payment or other event. **Trial balance**: the list of every account's totals, which must add up (all debits equal all credits).
- **Maker and checker**: one person asks for something sensitive and a different person approves it.
- **Step-up**: typing a fresh six-digit code from your authenticator app before a dangerous action. The code must be less than five minutes old.
- **Exception**: something the system records because a person should look at it, such as a void, an animal sold twice, or cash that does not add up.
- **Daily exception report**: the page that lists today's exceptions, with who, how much and which document.
- **Provisional reference**: the number printed on a receipt made while the till is offline. The official number follows when the till reconnects.
- **Offline**: the till has no network. It keeps selling and sends the sales later.

---

## 5. Scenario 1: a full trading day

### Purpose

Prove that a farm manager with no technical training can run a whole trading day: open the till, receive stock, sell animals by weight with a split payment, process an animal into meat, sell meat and eggs with tax, fulfil an online order, deliver it for cash on delivery, and close the day so that the cash, the stock and the books all agree.

### Who runs it

The owner or manager as the tester, directing: Adwoa Darko (till T1), Yaw Boateng, Kwesi Appiah (driver), Kwabena Owusu, Efua Asante, and a phone playing Ama Serwaa Ofori.

### Setup

Section 3 loaded. Before step 1, write down these counts from the Stock screen so you can check them at the end:

| Count | Before |
| --- | --- |
| Goats on hand (all goat pens) | ______ |
| Broiler chickens on hand | ______ |
| Beef, kg | ______ (88.200) |
| Chicken, kg | ______ (142.800) |
| Eggs, crates | ______ (40) |

### Steps

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 1.1 | Adwoa logs in at till T1 and opens a shift with an opening float of GHS 200.00 | A shift number `SHF-...` with status Open, float GHS 200.00, register T1, cashier Adwoa Darko. A second shift cannot be opened on T1 while this one is open | [ ] |
| 1.2 | Yaw logs in and opens the purchase order for Awutu Poultry Farm (20 broilers, GHS 1,040.00). He chooses "Receive goods", location Poultry house 1 (PEN-B1), quantity 20, and posts the goods receipt | A goods receipt `GRN-...`. A new lot of broiler chickens of 20 head, valued at GHS 1,040.00 (GHS 52.00 a head). Broiler chickens on hand rise by exactly 20. The purchase order shows 20 of 20 received | [ ] |
| 1.3 | Adwoa starts a sale at T1. She picks goat G-0142 and weighs it. Then G-0171. Then G-0157 | G-0142 at 26.400 kg: band GOAT-M, price GHS 850.00. G-0171 at 24.900 kg: GOAT-M, GHS 850.00. G-0157 at 31.800 kg: band GOAT-L, GHS 1,400.00. Each line shows "Scale" as the weight source. Tax on every line is GHS 0.00, marked zero-rated. Total **GHS 3,100.00** | [ ] |
| 1.4 | Adwoa takes the first part of the payment by mobile money: GHS 2,000.00. The customer (the tester, with the staging test number) approves on the phone | The sale shows "waiting for payment". There is no button that lets the cashier say "paid" herself. When the staging provider confirms, the tender turns to Paid GHS 2,000.00 within a minute | [ ] |
| 1.5 | Adwoa takes the rest in cash: GHS 1,100.00. The customer hands over GHS 1,200.00 | Change due **GHS 100.00**. The sale completes. A receipt prints with number `RCP-<year>-DDW-T1-<number>`, three goat lines, tenders mobile money GHS 2,000.00 and cash GHS 1,100.00, total GHS 3,100.00 | [ ] |
| 1.6 | Look at the three goats on the Stock screen | G-0142, G-0171 and G-0157 are no longer in the pens and show as Sold. Goats on hand fall by exactly 3 | [ ] |
| 1.7 | Yaw creates a processing order at the Processing room (PROC-1), output to the Cold room (COLD-1). Input: goat G-0175, weighed live at 24.100 kg. He adds two direct costs: labour GHS 40.00 ("slaughter and dressing") and consumables GHS 20.00 ("bags, labels and ice"). He starts it, then records the outputs: goat meat 13.000 kg as two packs (5.000 kg and 8.000 kg), offal 1.400 kg, waste 9.700 kg. He completes the order | Order `PRC-...` Completed. Yield **59.75 percent** (14.400 kg saleable out of 24.100 kg in) against the standard of 60.00 percent; no yield warning. Costs: goat G-0175 GHS 570.00 plus direct costs GHS 60.00 is **GHS 630.00** in total, shared between the outputs: goat meat lot **GHS 604.94**, offal lot **GHS 25.06**, waste GHS 0.00. 604.94 plus 25.06 is exactly 630.00. G-0175 now shows Slaughtered. Write down the goat meat lot number `MEAT-GOAT-...`: ______________ | [ ] |
| 1.8 | Adwoa starts a second sale at T1: beef pack 15.300 kg, the 5.000 kg goat meat pack from step 1.7, and 2 crates of eggs | Beef 15.300 kg at GHS 30.00 a kilogram is **GHS 459.00**. Goat meat 5.000 kg at GHS 39.00 is **GHS 195.00**. Eggs 2 crates at GHS 60.00 is **GHS 120.00**. Total **GHS 774.00** | [ ] |
| 1.9 | She pays GHS 800.00 in cash | Change due GHS 26.00. The receipt shows tax on each line: beef net GHS 382.50, VAT GHS 57.38, NHIL GHS 9.56, GETFund GHS 9.56 (these four add up to 459.00). Goat meat net GHS 162.50, VAT GHS 24.38, NHIL GHS 4.06, GETFund GHS 4.06 (add up to 195.00). Eggs GHS 120.00 at zero percent. Receipt totals: net **GHS 665.00**, VAT GHS 81.76, NHIL GHS 13.62, GETFund GHS 13.62, tax GHS 109.00, gross GHS 774.00 | [ ] |
| 1.10 | Adwoa makes a cash drop of GHS 1,000.00 to the safe. Then she takes an X report | The cash drop is recorded with her name. The X report says: 2 sales, gross GHS 3,874.00; cash GHS 1,874.00; mobile money GHS 2,000.00; float in GHS 200.00; cash drop GHS 1,000.00. It does not close the shift | [ ] |
| 1.11 | On a phone, Ama Serwaa Ofori opens the online shop and adds 2 packs of "Full chicken, 15 kg pack" and 2 crates of eggs to her cart. She goes to checkout, enters her address (Madina, digital address GM-091-4471), chooses the next delivery slot and "Pay on delivery" | The checkout shows: chicken estimated 30.000 kg at GHS 20.00 a kilogram, estimated GHS 600.00, highest possible GHS 660.00 (10 percent tolerance); eggs GHS 120.00. Delivery fee **GHS 0.00** (the order is over GHS 500.00). Estimated total **GHS 720.00**, of which tax GHS 100.00. Highest possible total **GHS 780.00**. A sentence explains that the chicken is weighed before dispatch and the final amount is based on the weighed quantity. She places the order. Order number `SO-...`, payment: cash on delivery. Stock for the chicken and eggs is reserved | [ ] |
| 1.12 | Yaw opens the order in the back office, creates the pick list and picks: two chicken packs from the chicken lot, weighed at 14.400 kg and 14.400 kg, and 2 crates of eggs | Total chicken weight **28.800 kg**, which is within 10 percent of 30.000 kg, so the customer is not asked anything. The chicken line becomes 28.800 kg at GHS 20.00 which is **GHS 576.00**. The order total is now **GHS 696.00** (576.00 plus 120.00) | [ ] |
| 1.13 | Yaw packs the order and marks it dispatched | An invoice `INV-...` is issued on the weighed quantity: net GHS 600.00 (chicken GHS 480.00, eggs GHS 120.00), VAT GHS 72.00, NHIL GHS 12.00, GETFund GHS 12.00, tax GHS 96.00, **gross GHS 696.00**. The cash to collect is fixed at **GHS 696.00** and the driver cannot change it | [ ] |
| 1.14 | Kwabena assigns the delivery to driver Kwesi Appiah and the delivery van. Kwesi opens his phone, sees only this delivery, and taps "On the way" | Delivery `DLN-...` assigned. Ama's phone receives a message that the driver is on the way (on staging, it shows in the test inbox). Kwesi sees nobody else's deliveries | [ ] |
| 1.15 | At the customer, Kwesi takes the recipient's name, takes the cash GHS 696.00 and records proof of delivery with the amount collected GHS 696.00 | Delivery Delivered with the time and position. Collected GHS 696.00 against due GHS 696.00. The order shows Delivered and Paid. If the phone has no signal, the proof is saved and sent later | [ ] |
| 1.16 | Back at the farm, Kwesi hands the GHS 696.00 to Kwabena. Kwabena (not Kwesi) records the driver cash reconciliation | Reconciled, difference GHS 0.00. Kwesi cannot reconcile his own cash | [ ] |
| 1.17 | Adwoa closes the shift blind. She counts the till and types: cash GHS 1,074.00, mobile money GHS 2,000.00 (from the provider's day total) | The screen did not show what was expected before she typed. After she submits: cash difference GHS 0.00, mobile money difference GHS 0.00. The shift waits for a supervisor | [ ] |
| 1.18 | Kwabena approves the count | Shift Closed. The Z report: 2 sales, gross GHS 3,874.00, voids 0, price changes 0, cash GHS 1,874.00, mobile money GHS 2,000.00; float in GHS 200.00, cash drop GHS 1,000.00. The shift cannot be closed or approved again | [ ] |
| 1.19 | Physically count the animals and packs, then compare with the Stock screen | Goats on hand: before minus 4 (three sold, one processed). Broilers: before plus 20. Beef lot 72.900 kg. Chicken lot 114.000 kg. Goat meat lot from step 1.7: 8.000 kg. Offal lot 1.400 kg. Eggs 36 crates. Every one matches what is physically there | [ ] |
| 1.20 | Efua opens the trial balance for today (from today to today) | "Balanced: yes". Total debits equal total credits to the pesewa. The accounts in the table below show the figures given | [ ] |
| 1.21 | Open the receipt from step 1.5 and press Reprint. Do the same for the invoice from step 1.13 | The reprint shows the same number, date and amounts, marked **Reprint**. The documents list shows, for today: two receipts, one invoice, one goods receipt, one processing order, one Z report, one proof of delivery. All can be opened and reprinted | [ ] |

### Trial balance figures for step 1.20

Use "from today to today", so the columns show only today's movement. Amounts in GHS.

| Account | Debits | Credits | What it is |
| --- | --- | --- | --- |
| 1000 Cash on hand, tills | 2,074.00 | 2,074.00 | Float 200.00 and cash sales 1,874.00 in; cash drop 1,000.00 and the close returning 1,074.00 out. The till ends at nothing |
| 1010 Cash, safe | 2,770.00 | 200.00 | Drop 1,000.00, close 1,074.00, driver 696.00 in; float 200.00 out |
| 1020 Cash held by drivers | 696.00 | 696.00 | Collected, then handed in |
| 1110 Mobile money wallets | 2,000.00 | 0.00 | The mobile money tender |
| 1200 Trade receivables | 4,570.00 | 4,570.00 | Three sales invoiced and all three paid in the day |
| 1310 Inventory, live animals | 1,040.00 | 2,519.50 | Broilers received; goats sold 1,949.50; goat processed 570.00 |
| 1325 Inventory, offal | 25.06 | 0.00 | Offal lot |
| 1340 Processing work in progress | 630.00 | 630.00 | Goat 570.00 plus direct costs 60.00, then outputs received |
| 2010 Goods received not invoiced | 0.00 | 1,040.00 | Broilers, no supplier invoice yet |
| 2020 Accrued processing costs | 0.00 | 60.00 | Labour and consumables |
| 2100 Output VAT and levies payable | 0.00 | 205.00 | VAT 153.76, NHIL 25.62, GETFund 25.62 (broken down by levy under the account) |
| 4000 Sales, live animals | 0.00 | 3,100.00 | |
| 4010 Sales, meat | 0.00 | 1,025.00 | Beef 382.50, goat meat 162.50, chicken 480.00 |
| 4020 Sales, produce and eggs | 0.00 | 240.00 | 120.00 at the counter, 120.00 online |
| 5000 Cost of sales, live animals | 1,949.50 | 0.00 | 612.50 plus 748.00 plus 589.00 |
| 4210 Price variance | 0.00 | 0.00 | No price changes today |

Other accounts appear for the cost of the meat and eggs sold (inventory of meat, produce, and their cost of sales). Their amounts depend on the seeded cost of the beef, chicken and eggs, so for those, check only that the whole trial balance is balanced.

### Result

| Checkpoint | Steps | Pass or fail | Date | Tester | Evidence |
| --- | --- | --- | --- | --- | --- |
| Float and shift opened | 1.1 | | | | |
| Stock received and valued | 1.2 | | | | |
| Goats sold by weight, split tender, change | 1.3 to 1.6 | | | | |
| Processing yield and cost allocation | 1.7 | | | | |
| Tax on meat, per line and per receipt | 1.8, 1.9 | | | | |
| Cash drop and X report | 1.10 | | | | |
| Online order, catch-weight re-pricing, invoice on weighed quantity | 1.11 to 1.13 | | | | |
| Delivery, cash on delivery, driver reconciliation | 1.14 to 1.16 | | | | |
| Blind close and Z report | 1.17, 1.18 | | | | |
| Physical stock equals system stock | 1.19 | | | | |
| Trial balance balanced and figures agree | 1.20 | | | | |
| Documents archived and reprintable | 1.21 | | | | |

Scenario passes only if every row passes. Notes: ____________________________________________

---

## 6. Scenario 2: quote to cash

### Purpose

Prove that a buyer who wants many animals for an event can ask for a price, get a quote, negotiate a change, accept, take part of the order, be invoiced, pay part, and show up correctly on the list of what customers owe, with the system holding every link between the documents.

### Who runs it

Kojo Antwi (sales), Kwabena Owusu (manager), Efua Asante (accountant), Yaw Boateng (storekeeper), Kwesi Appiah (driver), and a phone playing Emmanuel Tetteh.

### Setup

Section 3 loaded. Emmanuel Tetteh has a credit limit of GHS 9,000.00 and owes nothing. Write down today's date: ____ . It is called **day 0** below.

### Steps

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 2.1 | Kojo records a request for quote: customer Emmanuel Tetteh, 20 goats of 22 to 28 kg for a funeral, delivered to Kasoa on 11 December | A request `RFQ-...` with status New, linked to customer C-00241 | [ ] |
| 2.2 | Kojo builds a quote from it: 20 goats, band GOAT-M, price GHS 950.00 a head, delivery fee GHS 60.00 (before tax), valid for seven days, terms "50 percent deposit to reserve the animals" | The line shows the list price GHS 850.00 and the quoted price GHS 950.00 (above the list price, below the ceiling GHS 980.00, so no approval is needed). Goats GHS 19,000.00 at zero percent. Delivery GHS 60.00 plus VAT GHS 9.00, NHIL GHS 1.50, GETFund GHS 1.50. Net **GHS 19,060.00**, tax GHS 12.00, gross **GHS 19,072.00**. Estimated cost GHS 13,200.00 (20 times GHS 660.00). Margin **30.75 percent**, not below the margin floor | [ ] |
| 2.3 | Kojo issues the quote | Quote `QUO-...` version 1 Issued. Reserved goats rise by 20. A link is sent to Emmanuel's phone (on staging it shows in the test inbox) | [ ] |
| 2.4 | On his phone, Emmanuel opens the link | He sees version 1: 20 goats, the totals above, the 50 percent deposit term and the expiry date. He does not accept. He calls Kojo and asks for eighteen goats | [ ] |
| 2.5 | Kojo tries to change the numbers on version 1. Then he creates a new version instead: 18 goats at GHS 950.00, delivery GHS 60.00, change note "Reduced to eighteen goats" | Version 1 cannot be changed: an issued version is frozen. Version 2 shows goats GHS 17,100.00, net **GHS 17,160.00**, tax GHS 12.00, gross **GHS 17,172.00**, estimated cost GHS 11,880.00, margin **30.77 percent** | [ ] |
| 2.6 | Kojo issues version 2 | Version 1 shows Superseded. Reserved goats fall from 20 to 18 (version 1's reservation is released). A new link goes to Emmanuel. If Emmanuel opens the old link he is told it is no longer current and cannot accept it | [ ] |
| 2.7 | Emmanuel accepts version 2 on his phone | The quote shows Accepted, with the time and the version accepted. Pressing Accept a second time does nothing new: the quote can be accepted once | [ ] |
| 2.8 | Kojo converts the accepted quote to an order | One order `SO-...`, status Placed, 18 goats at GHS 950.00. The order shows the quote number, and the quote shows the order number. A second conversion of the same quote is refused | [ ] |
| 2.9 | Kojo confirms the order | The system stops it: Emmanuel's credit limit is GHS 9,000.00 and this order is GHS 17,172.00. It asks for approval. Kojo tries to approve it himself and is refused. He asks Kwabena. The request reaches Kwabena's approvals inbox | [ ] |
| 2.10 | Kwabena approves, with the reason "Funeral order, 50 percent deposit to follow" | The order is Confirmed. The credit override list shows customer Emmanuel Tetteh, order number, limit GHS 9,000.00, exposure GHS 17,172.00, approved by Kwabena Owusu, with today's date | [ ] |
| 2.11 | Efua records the deposit: bank transfer GHS 8,586.00 (50 percent of GHS 17,172.00), reference "UAT-TRANSFER-1" | A payment of GHS 8,586.00 held as a customer deposit. The order shows payment status Deposit held | [ ] |
| 2.12 | Yaw opens the order, creates the pick list, and picks 10 goats from pen PEN-G3 (tags G-0201 to G-0210), weighing each | Each goat shows its weight (all between 22.000 and 27.500 kg, so all in band GOAT-M and at GHS 950.00). The order shows 10 picked, 8 waiting | [ ] |
| 2.13 | Yaw packs and dispatches the 10 goats | An invoice `INV-...` is issued for the 10 goats: goats GHS 9,500.00 at zero percent; delivery fee GHS 60.00, VAT GHS 9.00, NHIL GHS 1.50, GETFund GHS 1.50. Net **GHS 9,560.00**, tax GHS 12.00, gross **GHS 9,572.00**. Due date is day 0 plus 30 days. The 8 goats not yet sent stay on the order as outstanding, still reserved, and the delivery fee is not charged again | [ ] |
| 2.14 | Efua allocates Emmanuel's deposit to the invoice | GHS 8,586.00 applied. Invoice outstanding **GHS 986.00**. Emmanuel's deposit balance GHS 0.00 | [ ] |
| 2.15 | Kwesi delivers the 10 goats to Kasoa and records proof of delivery, recipient Emmanuel Tetteh | Delivery Delivered. No cash is collected (account customer). The order shows 10 delivered, 8 outstanding | [ ] |
| 2.16 | Efua records a payment from Emmanuel: bank transfer GHS 500.00, reference "UAT-TRANSFER-2", allocated to the invoice | Invoice outstanding **GHS 486.00**, status Part paid | [ ] |
| 2.17 | Efua opens the receivables ageing report "as of" day 0 plus 30 days | Emmanuel Tetteh: **GHS 486.00 in the Current column** (it is due that very day, so not yet overdue). Credit limit GHS 9,000.00 | [ ] |
| 2.18 | Run the report "as of" day 0 plus 31 days | Emmanuel Tetteh: **GHS 486.00 in the 1 to 30 days overdue column** | [ ] |
| 2.19 | Run the report "as of" day 0 plus 61 days | Emmanuel Tetteh: **GHS 486.00 in the 31 to 60 days overdue column**. The totals line matches the sum of the customers listed | [ ] |
| 2.20 | Efua opens the trial balance for day 0 | Balanced. The accounts in the table below show the figures given. Emmanuel Tetteh's balance under account 1200 is GHS 486.00 | [ ] |
| 2.21 | Follow the links: from the invoice to the order, from the order to the quote, from the quote back to the request | Every link opens the right document. Nothing is missing from the chain request, quote version 2, order, invoice, deposit, payment | [ ] |

### Figures for step 2.20

| Account | Debits | Credits | What it is |
| --- | --- | --- | --- |
| 1100 Bank accounts | 9,086.00 | 0.00 | Deposit 8,586.00 and payment 500.00 |
| 1200 Trade receivables | 9,572.00 | 9,086.00 | Invoice in; deposit allocated 8,586.00 and payment 500.00 out. Balance GHS 486.00 |
| 1310 Inventory, live animals | 0.00 | 6,600.00 | Ten goats at GHS 660.00 |
| 2100 Output VAT and levies payable | 0.00 | 12.00 | VAT 9.00, NHIL 1.50, GETFund 1.50 |
| 2200 Customer deposits | 8,586.00 | 8,586.00 | Received, then allocated. Balance nil |
| 4000 Sales, live animals | 0.00 | 8,500.00 | Ten goats at the list price of GHS 850.00 |
| 4100 Delivery fee income | 0.00 | 60.00 | |
| 4210 Price variance | 0.00 | 1,000.00 | The extra GHS 100.00 a head the customer agreed to pay above the list price |
| 5000 Cost of sales, live animals | 6,600.00 | 0.00 | |

### Result

| Checkpoint | Steps | Pass or fail | Date | Tester | Evidence |
| --- | --- | --- | --- | --- | --- |
| Quote built with exact tax, cost and margin | 2.1 to 2.3 | | | | |
| Revision is a new version; the old version is frozen and cannot be accepted | 2.4 to 2.6 | | | | |
| Acceptance once only, conversion once only, links both ways | 2.7, 2.8, 2.21 | | | | |
| Credit limit stops the order; second person's override recorded | 2.9, 2.10 | | | | |
| Deposit held and then allocated | 2.11, 2.14 | | | | |
| Partial delivery, invoice for what was sent, balance still reserved | 2.12, 2.13, 2.15 | | | | |
| Part payment and outstanding balance | 2.16 | | | | |
| Ageing report correct at 30, 31 and 61 days | 2.17 to 2.19 | | | | |
| Books agree | 2.20 | | | | |

Notes: ____________________________________________

**Rules this scenario confirms.** Two of the rules above are the farm's reading of a point the documents leave open: that a credit check counts the whole unpaid order whatever deposit is still to come (step 2.9), and that a delivery fee is charged once, on the first dispatch of an order (step 2.13). If you want them different, write it in the notes; it is a decision for the owner, not a failure.

---

## 7. Scenario 3: traceability

### Purpose

Prove that any piece of meat sold can be traced back to the animal it came from, who sold the animal to the farm, and what the farm spent on it, in three clicks or fewer, and the other way round.

### Who runs it

Anyone. Part A needs scenario 1 to have been run on the same data. Part B needs only the starting facts.

### Part A: the goat meat sold in scenario 1

| # | Do this (count your clicks) | You should see | Pass or fail |
| --- | --- | --- | --- |
| 3.1 | Open the receipt from step 1.9 of scenario 1. Click the goat meat line (**click 1**) | The line shows the pack and its lot `MEAT-GOAT-...` and a Trace button | [ ] |
| 3.2 | Click Trace (**click 2**) | The lot, the 5.000 kg sale on the receipt (number, customer "walk-in", date), and an **ancestor**: goat **G-0175**, linked through the processing order `PRC-...` from scenario 1 | [ ] |
| 3.3 | Click goat G-0175 (**click 3**) | Supplier **Kpone Livestock Traders** (S-0012). Cost by kind: purchase **GHS 450.00**, feed **GHS 90.00**, veterinary **GHS 30.00**, processing **GHS 60.00**. The four add up to GHS 630.00, the cost of the animal and its processing (the meat lot's own share of that is GHS 604.94 and the offal lot's GHS 25.06). Health: deworming, Albendazole 10% oral, 22 October 2026, withdrawal ended 5 November 2026, which is before the animal was processed | [ ] |
| 3.4 | You reached the animal, supplier and costs in three clicks or fewer | Count: ____ clicks. Three or fewer is a pass | [ ] |
| 3.5 | Now go forward. Open goat G-0175 and use "Where did it go?" | It shows processing order `PRC-...`, goat meat lot (13.000 kg: 5.000 kg sold on the receipt, 8.000 kg in the cold room) and the offal lot (1.400 kg, in the cold room) | [ ] |

### Part B: a lot from the starting data

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 3.6 | Open the lot `MEAT-GOAT-261109-01` and click Trace | Ancestor: goat **G-0118**, through processing order `PRC-2026-DDW-000012`. Supplier **Kpone Livestock Traders**. Cost by kind: purchase GHS 520.00, feed GHS 98.00, veterinary GHS 43.00, processing GHS 60.00 (total GHS 721.00). Health event: deworming, Albendazole 10% oral, 20 October 2026, withdrawal ended 3 November 2026 | [ ] |
| 3.7 | Look at where the lot was sold | Two sales: 15.200 kg to **Royal Palm Hotel Ltd** on invoice `INV-2026-DDW-001190` (12 November), and 14.850 kg at the counter on receipt `RCP-2026-DDW-T1-018820` (13 November) | [ ] |
| 3.8 | Pick any other lot that has been sold (for example the beef lot) and trace it | You reach an animal or a documented source, the supplier and the costs in three clicks or fewer. If a lot cannot be traced, write down which lot: ______________ | [ ] |

### Result

| Checkpoint | Steps | Pass or fail | Date | Tester | Evidence |
| --- | --- | --- | --- | --- | --- |
| Sold lot traced to animal in three clicks or fewer | 3.1 to 3.4 | | | | |
| Costs by kind match and add up | 3.3 | | | | |
| Forward trace from the animal | 3.5 | | | | |
| A lot from starting data traces to its animal, supplier, costs and customers | 3.6, 3.7 | | | | |
| Another lot of your choice traces | 3.8 | | | | |

Notes: ____________________________________________

---

## 8. Scenario 4: investor distribution

### Purpose

Prove that the profit share for July to September 2026 is worked out the way the owner decided (units multiplied by days held, the contribution day counts, the withdrawal day does not), that you can repeat it with a calculator and get the same figure to the pesewa, that nobody is paid a pesewa too much or too little, and that the amounts in the books tie to the distribution.

### Who runs it

The accountant (Efua Asante) runs the system. The owner (Akua Mensah) approves. A second person, who is not Efua, does the hand calculation in part A with a calculator before looking at the system. The rule is in `docs/adr/0028-investor-distribution-allocation.md`.

### Setup

Section 3 loaded, including the investor table in 3.5. The period is **1 July 2026 to 30 September 2026**, which is 92 days: July 31 plus August 31 plus September 30. Both the first and last day count.

### Part A: the hand calculation (do this before opening the distribution screen)

**Step 1. Count the days each investor held units.** A holding counts on its starting day and every day after. Use the effective dates in 3.5.

| Investor | Units | Held from | Days in the period | Unit-days (units times days) |
| --- | --- | --- | --- | --- |
| Ama Owusu-Ansah | 1,000 | Before 1 July (all 92 days) | 92 | 1,000 x 92 = **92,000** |
| Kofi Ampofo | 500 | 15 August: 17 days in August (15 to 31) plus 30 in September | 47 | 500 x 47 = **23,500** |
| Esi Bonsu | 250 | Before 1 July | 92 | 250 x 92 = 23,000 |
| Esi Bonsu | 250 | 1 September: 30 days | 30 | 250 x 30 = 7,500 |
| | Esi total | | | **30,500** |
| Yaw Frimpong | 200 | Before 1 July | 92 | 200 x 92 = **18,400** |
| Akwaaba Diaspora Agro Fund | 2,000 | 15 July: 17 days in July (15 to 31) plus 31 plus 30 | 78 | 2,000 x 78 = **156,000** |
| **Total unit-days** | | | | **320,400** |

Check on the calculator: 92,000 + 23,500 + 30,500 + 18,400 + 156,000 = 320,400.

**Step 2. Find the amount to share.** Net profit for July to September is GHS 41,666.70, which is 4,166,670 pesewas. The farm keeps 40 percent:

- Kept by the farm: 4,166,670 x 0.40 = 1,666,668 pesewas = **GHS 16,666.68**
- To share: 4,166,670 − 1,666,668 = 2,500,002 pesewas = **GHS 25,000.02**

**Step 3. Work out each investor's exact share.** Share = 2,500,002 x investor's unit-days / 320,400. Do it in pesewas.

| Investor | Calculation | Exact share (pesewas) | Whole pesewas | Left over (fraction) |
| --- | --- | --- | --- | --- |
| Ama | 2,500,002 x 92,000 / 320,400 | 717,853.2584 | 717,853 | .2584 |
| Kofi | 2,500,002 x 23,500 / 320,400 | 183,364.6910 | 183,364 | .6910 |
| Esi | 2,500,002 x 30,500 / 320,400 | 237,983.9606 | 237,983 | .9606 |
| Yaw | 2,500,002 x 18,400 / 320,400 | 143,570.6517 | 143,570 | .6517 |
| Akwaaba | 2,500,002 x 156,000 / 320,400 | 1,217,229.4382 | 1,217,229 | .4382 |

**Step 4. Hand out the leftover pesewas.** Add the whole pesewas: 717,853 + 183,364 + 237,983 + 143,570 + 1,217,229 = **2,499,999**. That is 3 short of 2,500,002. The 3 leftover pesewas go one each to the three biggest fractions: Esi (.9606), Kofi (.6910) and Yaw (.6517). (If two fractions were equal, the lower investor number would win.)

**Step 5. The answer you should reach.**

| Investor | Allocated (pesewas) | Allocated (GHS) | Share of the total unit-days |
| --- | --- | --- | --- |
| Ama Owusu-Ansah | 717,853 | **7,178.53** | 28.714 percent |
| Kofi Ampofo | 183,365 | **1,833.65** | 7.335 percent |
| Esi Bonsu | 237,984 | **2,379.84** | 9.519 percent |
| Yaw Frimpong | 143,571 | **1,435.71** | 5.743 percent |
| Akwaaba Diaspora Agro Fund | 1,217,229 | **12,172.29** | 48.689 percent |
| **Total** | **2,500,002** | **25,000.02** | 100 percent |

If you rounded each share on its own instead, you would still get 2,500,002 here only by luck; the rule of handing out the leftovers is what guarantees it every time. A check that matters: the five amounts add up to exactly 25,000.02.

### Part B: in the system

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 4.1 | Efua opens the capital register "as of" 30 September 2026 | Ama 1,000 units; Kofi 500; Esi 500; Yaw 200; Akwaaba 2,000; total **4,200 units**, GHS 420,000.00 paid in. (Holding percentages here, such as Akwaaba 47.62 percent, are shares of units held on one day. They are different from the unit-days shares above, which allow for how long units were held.) | [ ] |
| 4.2 | Efua opens the income statement for 1 July to 30 September 2026 | Net profit **GHS 41,666.70** | [ ] |
| 4.3 | Efua tries to create a distribution run while the three months are still open | Refused. The periods must be locked or closed first. She locks July, August and September | [ ] |
| 4.4 | Efua creates a distribution run for 1 July 2026 to 30 September 2026 | A draft run `DST-...`. Days in period **92**. Net profit GHS 41,666.70. Retention 40.00 percent. Kept GHS 16,666.68. To share **GHS 25,000.02**. Method: unit-days. The convention is written on the run: actual calendar days in Africa/Accra, both ends of the period counted, the contribution day counts, the withdrawal day does not. Total unit-days **320,400** | [ ] |
| 4.5 | Compare each line with your hand calculation from part A | Unit-days: 92,000; 23,500; 30,500; 18,400; 156,000. Allocated: 7,178.53; 1,833.65; 2,379.84; 1,435.71; 12,172.29. Kofi, Esi and Yaw are marked as having received an extra pesewa. Tax withheld GHS 0.00 on each line. Every number equals yours | [ ] |
| 4.6 | Efua submits the run for approval, then tries to approve it herself | She cannot approve her own run. It shows Pending approval | [ ] |
| 4.7 | Akua opens the run and approves it. The system asks for a fresh code from her authenticator app | Without the code the approval is refused. With a code less than five minutes old, the run is Approved. The approval is recorded with her name and the time | [ ] |
| 4.8 | Efua posts the run to the ledger | The run shows Posted. In the trial balance for the period: account 3300 Distributions declared is debited GHS 25,000.02 in all. Account 2300 Distributions payable is credited GHS 7,178.53, GHS 1,833.65, GHS 2,379.84, GHS 1,435.71 and GHS 12,172.29 against the five investors. The credits add up to the debit exactly. Nothing is posted for the GHS 16,666.68 the farm keeps. The trial balance stays balanced | [ ] |
| 4.9 | Efua records the payments: GHS 1,435.71 to Yaw Frimpong by mobile money, and the other four by bank transfer, each for the amount allocated | Each line shows Paid. Account 2300 for every investor returns to GHS 0.00. The run shows Paid with total paid GHS 25,000.02 | [ ] |
| 4.10 | Ama Owusu-Ansah logs into the investor portal | She sees her own units (1,000), her distribution **GHS 7,178.53** and her statement. She cannot see any other investor's name or figures | [ ] |
| 4.11 | Kofi Ampofo logs into the portal | He sees **GHS 1,833.65**, and 500 units. Nothing of Ama's | [ ] |
| 4.12 | Try to post the same run a second time, then approve it again | Both refused: a run is posted once | [ ] |

### Result

| Checkpoint | Steps | Pass or fail | Date | Tester | Evidence |
| --- | --- | --- | --- | --- | --- |
| Hand calculation matches the system to the pesewa | Part A, 4.4, 4.5 | | | | |
| The five amounts add up to exactly GHS 25,000.02 | 4.5 | | | | |
| Period must be locked first | 4.3 | | | | |
| Maker cannot approve; owner approves with fresh code | 4.6, 4.7 | | | | |
| Posting ties to the ledger, trial balance balanced | 4.8 | | | | |
| Payments clear what is owed | 4.9 | | | | |
| Investors see only their own figures | 4.10, 4.11 | | | | |
| Run cannot be posted twice | 4.12 | | | | |

Notes: ____________________________________________

---

## 9. Scenario 5: fraud attempts

### Purpose

The system was designed around the risk that someone with a valid login does something dishonest. The threat model (`docs/security/THREAT_MODEL.md`, section 4) lists eighteen ways. This scenario has you try every one. For each there are two checks, and both must pass (owner instruction of 2026-11-13):

1. **Blocked or flagged.** The system refuses the attempt, or lets it happen only through a second person, and keeps a record.
2. **On the daily exception report.** The attempt appears on the daily exception report, whether or not it was blocked, with enough detail (who, how much, which document) for you to act on it.

### Who runs it

The owner or manager as the tester, directing everyone listed in section 2. The administrator is needed only for cases 5, 10 and 15, where a technical person must send a forged message, delete an entry from the till's memory, or tamper with the database on staging; they do exactly what is written and nothing else.

### Setup

Section 3 loaded and a clean day. Do the cases in order. Case 15 goes last, because it damages staging, and scenario 7 restores it. Before you start, open the daily exception report for today and confirm it is empty.

### How to read the cases

Each case has a table of steps, then two lines to mark: **A** (blocked or flagged) and **B** (on the report). The report check is done at the end, in part C, against everything you did. The report item names a **kind**; each item also lists the abuse case numbers it helps detect.

### Case 1: a cashier takes the cash and voids the sale

Threat model case 1. Kind on the report: `SALE_VOID`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.1.1 | Adwoa sells 3 crates of eggs at T1 for cash: GHS 180.00. The customer pays and leaves | Receipt `RCP-...`, total GHS 180.00 | [ ] |
| 5.1.2 | Adwoa requests a void of that sale, then tries to approve it herself | She can request but not approve. The order is not voided yet | [ ] |
| 5.1.3 | Kwabena (not Adwoa) approves the void, with a reason | The order shows Voided. A credit note for GHS 180.00 exists. The eggs are back in stock. The original receipt stays on record and cannot be deleted | [ ] |

### Case 2: a storekeeper reports a healthy animal as dead

Threat model case 2. Kind: `MORTALITY`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.2.1 | Yaw reports goat G-0171 dead (value GHS 589.00, above the GHS 300.00 limit) with no photograph | Refused: a photograph is required above the limit | [ ] |
| 5.2.2 | Yaw adds a photograph and submits | The record shows Pending approval. The goat is still counted in stock. Yaw tries to approve it himself and cannot | [ ] |
| 5.2.3 | Kwabena looks at the pen, sees the goat alive and rejects the record with a reason | Status Rejected. G-0171 stays alive and in stock | [ ] |

### Case 3: many small price reductions at the counter

Threat model case 3. Kind: `PRICE_OVERRIDE`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.3.1 | Adwoa sells G-0201 at GHS 810.00 (list GHS 850.00), giving the reason "regular customer" | Allowed: GHS 40.00 is 4.7 percent below list, inside her 10 percent line limit | [ ] |
| 5.3.2 | Adwoa sells G-0202 at GHS 810.00 the same way | Allowed. Her total reductions this shift are GHS 80.00 | [ ] |
| 5.3.3 | Adwoa sells G-0203 at GHS 810.00 | Refused until approved: it would take her total this shift to GHS 120.00, over her GHS 100.00 limit. A request goes to the manager. Adwoa tries to sell without a reason and is refused | [ ] |
| 5.3.4 | Kwabena approves the third reduction | The sale completes. Each of the three reductions is recorded to account 4210 (price variance) with Adwoa's shift as the source | [ ] |

### Case 4: a customer shows a fake mobile money message

Threat model case 4. Kind: `UNMATCHED_PAYMENT`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.4.1 | At T2, Nana starts a sale of 4 crates of eggs, GHS 240.00. The customer shows a screenshot saying "GHS 240.00 sent". Nana chooses mobile money | The sale waits for the provider. There is no way to mark it paid on the cashier's word | [ ] |
| 5.4.2 | Nana presses "Check payment" | The system asks the provider and reports "no payment found". The sale does not complete | [ ] |
| 5.4.3 | Nana cancels the mobile money tender | The sale is not completed and no stock leaves | [ ] |

### Case 5: a forged message from the payment provider

Threat model case 5. Kind: `WEBHOOK_REJECTED`. **Administrator.**

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.5.1 | Ama Serwaa Ofori places an online order for 2 crates of eggs, GHS 120.00, paying by mobile money, and does not approve the prompt | The order is awaiting payment | [ ] |
| 5.5.2 | The administrator sends to the payment endpoint a message claiming that order is paid, signed with a wrong key | Rejected. The order is still awaiting payment | [ ] |
| 5.5.3 | The administrator sends a genuine-looking old message again (an already used event) and one with a timestamp ten minutes old | Both rejected. Nothing changes on the order | [ ] |
| 5.5.4 | Kwabena opens the webhook rejection log | Three rejections, each with the reason (wrong signature, already seen, too old) | [ ] |

### Case 6: a driver collects cash and hands in less

Threat model case 6. Kind: `DRIVER_VARIANCE`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.6.1 | Ama Serwaa Ofori orders 4 crates of eggs online, cash on delivery. Yaw picks and dispatches | Eggs GHS 240.00 plus delivery GHS 30.00 (tax included, the order is under GHS 500.00): total due **GHS 270.00**, fixed by the system | [ ] |
| 5.6.2 | Kwesi opens the delivery on his phone and looks for a way to change the amount due | There is none. He can only record what he collected | [ ] |
| 5.6.3 | Kwesi records proof of delivery with collected **GHS 170.00** | Accepted, but flagged: GHS 100.00 less than due | [ ] |
| 5.6.4 | Kwesi tries to reconcile his own cash. Then Kwabena reconciles: Kwesi hands in GHS 170.00 | Kwesi cannot reconcile his own cash. The difference is **GHS 100.00 short**, recorded against Kwesi Appiah and posted to cash over and short (account 6900) | [ ] |

### Case 7: a stock adjustment used to hide a shortage

Threat model case 7. Kind: `STOCK_ADJUSTMENT`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.7.1 | Yaw drafts an adjustment: Oxytetracycline injection down by 6 units, reason "count loss" (6 times GHS 85.00 is GHS 510.00, above the GHS 200.00 limit) | The adjustment cannot be posted. It needs a second person. Stock still shows 10 units | [ ] |
| 5.7.2 | Yaw tries to approve it himself, and tries to choose a reason that is not on the list | He cannot approve. Only the fixed reasons are offered | [ ] |
| 5.7.3 | Kwabena approves | Stock shows 4 units. The adjustment cannot be edited or deleted afterwards. A write-off of GHS 510.00 is in the books | [ ] |

### Case 8: an investor reaches finance data

Threat model case 8. Kind: `AUTHORISATION_FAILURE`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.8.1 | On the staff login page, Ama Owusu-Ansah types her investor email and password | Refused with the same wording used for a wrong password. It does not say that the account exists | [ ] |
| 5.8.2 | Logged in to the investor portal, Ama changes the investor number in the address bar from her own to INV-002 (Kofi) | Not available. No name or figure of Kofi's is shown | [ ] |
| 5.8.3 | Ama types the address of the trial balance page | Refused. Nothing from finance is shown | [ ] |

### Case 9: an insider exports the customer list

Threat model case 9. Kind: `BULK_EXPORT`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.9.1 | Adwoa (cashier) tries to export the customer list | Refused: no permission | [ ] |
| 5.9.2 | Efua (accountant) tries to export it | The system asks for a fresh authenticator code. Without one, refused | [ ] |
| 5.9.3 | Efua enters a fresh code and exports | The export is made. Note the number of rows ______ , it equals the number of customers on the customer list screen | [ ] |

### Case 10: an offline sale made and deleted before it syncs, and Case 11: an animal sold that is on hold

Threat model cases 10 and 11. Kinds: `DEVICE_COUNTER_GAP` and `STOCK_EXCEPTION`. **Administrator** for 5.10.4.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.10.1 | Adwoa opens a shift on T1 and prepares the till for offline work. Then she disconnects the till | The till shows "Working offline" | [ ] |
| 5.10.2 | Kwabena (online, on another device) places a veterinary withdrawal hold on goat G-0204 for 14 days after a treatment | G-0204 shows On hold. The offline till does not know | [ ] |
| 5.10.3 | Offline, Adwoa makes four cash sales: number 1, one crate of eggs, GHS 60.00. Number 2, goat G-0204 at GHS 850.00. Number 3, one crate, GHS 60.00. Number 4, one crate, GHS 60.00 | Each receipt shows a provisional reference ending 1, 2, 3, 4 | [ ] |
| 5.10.4 | The administrator deletes sale number 3 from the till's memory with the browser's storage tool | The till now holds sales 1, 2 and 4 | [ ] |
| 5.10.5 | Adwoa reconnects. The till sends its sales | Three sales are accepted (1, 2 and 4) with official receipt numbers. Sale 2 is recorded together with its GHS 850.00 payment, so the till cash is right, but goat G-0204 does not leave the pen: it stays On hold | [ ] |
| 5.10.6 | Open the stock exceptions queue | One exception: goat G-0204 sold at till T1 while on a veterinary hold, showing the hold and the sale. Separately, a gap exception: counter number 3 is missing in this shift (numbers 2 and 4 were seen) | [ ] |

### Case 12: a false return to get a refund

Threat model case 12. Kind: `REFUND`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.12.1 | Adwoa sells 2 crates of eggs at T1 for cash, GHS 120.00. Later she starts a return for 3 crates against that receipt | Refused: more than was sold | [ ] |
| 5.12.2 | She starts a return for 2 crates and asks for the refund to go to a mobile money number | Refused: a refund goes back by the method the customer paid with, which was cash | [ ] |
| 5.12.3 | She asks for a cash refund of GHS 120.00 (above the GHS 100.00 limit) | It waits for a second person. She tries to approve it and cannot | [ ] |
| 5.12.4 | Kwabena approves | Refund GHS 120.00 in cash, a credit note, the eggs back in stock. A second return of the same eggs is refused | [ ] |

### Case 13: a supplier's payment details changed to divert money

Threat model case 13. Kind: `PAYOUT_DETAIL_CHANGE`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.13.1 | Efua opens supplier Kpone Livestock Traders and changes the bank account number to 0123 4567 8901 | The change is saved as a request. The supplier still shows the old (masked) details. A normal screen shows only the last four digits | [ ] |
| 5.13.2 | Efua tries to approve her own change | Refused | [ ] |
| 5.13.3 | Akua approves with a fresh authenticator code | The new details take effect. The audit trail shows who changed them and who approved, and keeps the old ones | [ ] |

### Case 14: credit given beyond the limit to a favoured customer

Threat model case 14. Kind: `CREDIT_OVERRIDE`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.14.1 | Kojo creates an order for Royal Palm Hotel for 10 goats at GHS 850.00, GHS 8,500.00, and tries to confirm it | Stopped: the hotel owes GHS 11,644.00 against a limit of GHS 20,000.00. With this order it would owe **GHS 20,144.00**, which is **GHS 144.00** over | [ ] |
| 5.14.2 | Kojo tries to approve the override himself | Refused | [ ] |
| 5.14.3 | Kwabena approves with the reason "Regular monthly order, payment promised Friday" | Order Confirmed. The credit override list shows Royal Palm Hotel Ltd, the order, limit GHS 20,000.00, exposure GHS 20,144.00, approved by Kwabena Owusu | [ ] |

### Case 16: a manager gives themselves or a friend a higher role

Threat model case 16. Kind: `PERMISSION_CHANGE`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.16.1 | Kwabena opens the users screen and tries to give Adwoa Darko the Manager role. The system asks for an authenticator code; he enters one that is more than five minutes old | The change is refused. A fresh code is required | [ ] |
| 5.16.2 | He enters a fresh code | The change is made and written to the audit trail with his name, the role, the person, the time and the old and new roles | [ ] |
| 5.16.3 | Reverse it: take the role away again, also with a fresh code | Done and audited | [ ] |

### Case 17: a shift closed short

Threat model case 17. Kind: `SHIFT_OVER_SHORT`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.17.1 | Nana opens a shift at T2 with a float of GHS 200.00, sells 10 crates of eggs for cash, GHS 600.00, and closes blind, declaring cash **GHS 680.00** | The screen does not show the expected amount before she submits. After: expected GHS 800.00, declared GHS 680.00, **GHS 120.00 short** | [ ] |
| 5.17.2 | Nana tries to approve her own close. Then Kwabena approves | Nana is refused. With Kwabena's approval the shift is Closed. GHS 120.00 recorded as cash short against Nana, in account 6900 | [ ] |

### Case 18: processing yield under-recorded

Threat model case 18. Kind: `YIELD_VARIANCE`.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.18.1 | Yaw processes goat G-0205 weighed live at 25.000 kg, records saleable output of 12.500 kg and the rest as waste, and completes the order | Yield **50.00 percent** against the standard 60.00 percent (tolerance 5.00 points). The order is flagged "yield variance" for review. It still completes, and all the cost goes to the outputs recorded | [ ] |

### Case 15: the ledger or audit trail altered directly in the database

Threat model case 15. Kinds: `AUDIT_INTEGRITY` and `RECONCILIATION_BREAK`. **Administrator.** Run this case last.

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 5.15.1 | The administrator connects to staging's database as the application and tries to change one journal line's amount, and tries to delete one audit event | Both refused by the database itself | [ ] |
| 5.15.2 | The administrator, with the owner watching, uses the database owner's access to turn off the protective trigger, change one journal line and one audit event on staging, and turn the trigger back on | The change is made (this proves why the next step matters) | [ ] |
| 5.15.3 | The administrator runs the nightly verification and reconciliation jobs now | The audit check reports a break at exactly the altered event; the reconciliation reports that the ledger and the balances no longer agree for the altered journal | [ ] |
| 5.15.4 | Open the audit integrity page as the owner | Status failed, with the event where the chain breaks | [ ] |

### Part C: the daily exception report

Open the daily exception report for today (menu: Reports, Exceptions, Daily report). It is built as things happen. Go through the table: tick **A** (the attempt was blocked or flagged, from the case above) and **B** (the report shows it). An item must show who did it, how much, and which document.

| Case | Kind the item must have | What the item must show | A | B |
| --- | --- | --- | --- | --- |
| 1 | `SALE_VOID` | Adwoa Darko, GHS 180.00, the sales order, "void ... requested by Adwoa Darko" | [ ] | [ ] |
| 2 | `MORTALITY` | Yaw Boateng, GHS 589.00, goat G-0171, his rate against the pen average | [ ] | [ ] |
| 3 | `PRICE_OVERRIDE` | Three items, Adwoa Darko, GHS 40.00 each (GHS 120.00 together), goat tags G-0201, G-0202, G-0203, the third approved by Kwabena Owusu | [ ] | [ ] |
| 4 | `UNMATCHED_PAYMENT` | Nana Yeboah, GHS 240.00, till T2, "mobile money not verified" | [ ] | [ ] |
| 5 | `WEBHOOK_REJECTED` | Three items for the forged messages, each with its reason, the order they claimed to pay | [ ] | [ ] |
| 6 | `DRIVER_VARIANCE` | Kwesi Appiah, GHS 100.00, the delivery, "handed in GHS 170.00 of GHS 270.00" | [ ] | [ ] |
| 7 | `STOCK_ADJUSTMENT` | Yaw Boateng, GHS 510.00, the adjustment, reason "count loss" | [ ] | [ ] |
| 8 | `AUTHORISATION_FAILURE` | Ama Owusu-Ansah, what she tried to reach (investor INV-002, the trial balance) | [ ] | [ ] |
| 9 | `BULK_EXPORT` | Efua Asante, "customer list exported", the row count from step 5.9.3. Adwoa's refused attempt also shows as an authorisation failure | [ ] | [ ] |
| 10 | `DEVICE_COUNTER_GAP` | Adwoa Darko, till T1, the shift, counter 3 missing | [ ] | [ ] |
| 11 | `STOCK_EXCEPTION` | Adwoa Darko, goat G-0204 sold while on a veterinary hold, GHS 850.00 | [ ] | [ ] |
| 12 | `REFUND` | Adwoa Darko, GHS 120.00 refund, the original receipt | [ ] | [ ] |
| 13 | `PAYOUT_DETAIL_CHANGE` | Efua Asante, supplier Kpone Livestock Traders, approved by Akua Mensah | [ ] | [ ] |
| 14 | `CREDIT_OVERRIDE` | Kojo Antwi, Royal Palm Hotel Ltd, limit GHS 20,000.00, exposure GHS 20,144.00, GHS 144.00 over, approved by Kwabena Owusu | [ ] | [ ] |
| 15 | `AUDIT_INTEGRITY` and `RECONCILIATION_BREAK` | The altered event and journal, with the time the check ran | [ ] | [ ] |
| 16 | `PERMISSION_CHANGE` | Kwabena Owusu granted Manager to Adwoa Darko | [ ] | [ ] |
| 17 | `SHIFT_OVER_SHORT` | Nana Yeboah, GHS 120.00 short, the shift | [ ] | [ ] |
| 18 | `YIELD_VARIANCE` | Yaw Boateng, the processing order, 50.00 against 60.00 percent | [ ] | [ ] |

Also check on the report: each item carries the abuse case number it detects; items are listed with the date; the summary of each is readable by someone who was not there; the report also shows the rates by person (voids by cashier, price reductions by cashier, mortality by handler, driver variances, exports, short and over, and which people approve each other's requests).

### Result

Scenario 5 passes only if all eighteen cases pass both A and B.

| Checkpoint | Cases | Pass or fail | Date | Tester | Evidence |
| --- | --- | --- | --- | --- | --- |
| Cash and till controls blocked or flagged | 1, 3, 4, 17 | | | | |
| Stock and animal controls blocked or flagged | 2, 7, 10, 11, 18 | | | | |
| Payments and delivery controls blocked or flagged | 5, 6, 12 | | | | |
| Access, export, role and supplier-detail controls blocked or flagged | 8, 9, 13, 16 | | | | |
| Credit control | 14 | | | | |
| Tamper detection | 15 | | | | |
| All eighteen appear on the daily exception report with who, how much and which document | Part C | | | | |

Notes: ____________________________________________

---

## 10. Scenario 6: offline counter

### Purpose

Prove that when the shop loses its network the till keeps selling; that when it reconnects every sale arrives once and only once; that no real sale is ever thrown away; and that when what the till believed about stock turns out to be wrong, the system flags it for a person instead of quietly picking a winner. The rules are in `docs/adr/0027-offline-sync-principles.md`.

### Who runs it

Adwoa Darko at till T1 (offline), Nana Yeboah at till T2 (online), Kwabena Owusu, and the administrator only to switch the network off and on.

### Setup

Section 3 loaded. In particular, eggs: exactly 40 crates. Goats G-0206 to G-0209 are for sale in PEN-G3. Till T1 and till T2 are both enrolled devices.

### Steps

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 6.1 | Adwoa opens a shift on T1 (float GHS 200.00). Write down the shift number: ________ | Shift Open | [ ] |
| 6.2 | Nana opens a shift on T2 (float GHS 200.00) | Shift Open | [ ] |
| 6.3 | On T1, Adwoa presses "Prepare for offline" | The till reports that prices, stock and limits were stored, and shows the time they were fetched. It shows goats G-0206 to G-0209 and the eggs as for sale | [ ] |
| 6.4 | The administrator switches T1's network off (wifi off or cable out). Write the time: ______ | T1 shows "Working offline". Selling is still possible. It shows how many sales are waiting: 0 | [ ] |
| 6.5 | On T2 (online), Nana sells goat **G-0206** for cash at GHS 850.00, then sells 3 crates of eggs for cash at GHS 180.00 | Both complete with official receipt numbers at once. Eggs on the server are now 37. Goat G-0206 is Sold | [ ] |
| 6.6 | Offline on T1, Adwoa makes **fifty cash sales** over about an hour, as in the table below, taking each one in order. The customer pays the exact amount | Each prints a receipt with a **provisional reference** of the form `P-T1-<shift number>-<counter>`, counters 1 to 50 with no gap, plus a QR code, and a line that the official number follows. The waiting count rises to 50 | [ ] |
| 6.7 | While offline, Adwoa tries to take a mobile money payment, and tries to sell a goat at GHS 700.00 (more than 10 percent below the list price) | Mobile money: not available offline, cash only. The GHS 700.00 price: refused, beyond her limit. Neither is counted in the fifty | [ ] |
| 6.8 | The administrator switches T1's network back on. Sync starts. When the screen shows between 10 and 30 sent, the administrator switches the network off again for a minute and back on | Sync stops and resumes without asking Adwoa for anything. No sale appears twice | [ ] |
| 6.9 | Wait for sync to finish | **50 sent, 0 waiting, 0 failed.** Each sale now shows its official receipt number `RCP-<year>-DDW-T1-...` beside its provisional reference. The official numbers are consecutive, none skipped | [ ] |
| 6.10 | Press "Sync now" again, then reload the till | Nothing to send. Still exactly 50 sales on shift. No duplicates in the order list | [ ] |
| 6.11 | Open one offline sale in the back office | It shows "sold at" the time Adwoa actually made it (during the offline hour) and "recorded at" the later time the server received it | [ ] |
| 6.12 | Kwabena takes an X report on shift T1 | 50 sales, gross **GHS 6,160.00**, all cash. Mobile money GHS 0.00 | [ ] |
| 6.13 | Kwabena opens the stock exceptions queue | **Four** exceptions, each naming Adwoa Darko, till T1 and this shift. **Three** "countable stock below zero" for eggs, for sales number 38, 39 and 40: the server had 37 crates when sync began. One "animal already sold" for sale number 47: goat G-0206, sold at till T2 at the time in step 6.5 and at T1 offline | [ ] |
| 6.14 | Open sale number 47 and one of the three egg sales | Both are complete: receipt, payment recorded. The sale line has no stock movement, and the exception stands in its place. Nothing was refused and no cash is missing. Eggs show as minus 3 crates until someone resolves it. Goat G-0206 is still Sold once, to the customer at T2 | [ ] |
| 6.15 | Kwabena resolves the goat exception with the note "Goat G-0206 sold at T2 at the earlier time; T1 customer to be given G-0210 instead", and resolves the three egg exceptions with "Recount: three crates were recorded late" | Each exception shows Resolved with the note and Kwabena's name. They still appear on today's daily exception report | [ ] |
| 6.16 | Adwoa closes shift T1 blind and declares cash **GHS 6,360.00** | Expected: float 200.00 plus 6,160.00. Difference GHS 0.00. Kwabena approves. The Z report: 50 sales, gross GHS 6,160.00 | [ ] |
| 6.17 | Nana closes shift T2 blind and declares cash **GHS 1,230.00** | Expected: float 200.00 plus 850.00 plus 180.00. Difference GHS 0.00. Approved | [ ] |
| 6.18 | Efua opens the trial balance for today | Balanced. Account figures as in the table below | [ ] |

Fifty sales, in this order:

| Counter | What | Price each | Subtotal |
| --- | --- | --- | --- |
| 1 to 40 | 1 crate of eggs | GHS 60.00 | GHS 2,400.00 |
| 41 to 46 | Beef, 2.000 kg each, weighed on the scale | GHS 60.00 (GHS 30.00 a kilogram) | GHS 360.00 |
| 47 | Goat G-0206 | GHS 850.00 | GHS 850.00 |
| 48 | Goat G-0207 | GHS 850.00 | GHS 850.00 |
| 49 | Goat G-0208 | GHS 850.00 | GHS 850.00 |
| 50 | Goat G-0209 | GHS 850.00 | GHS 850.00 |
| | **Total** | | **GHS 6,160.00** |

Each beef sale of GHS 60.00 includes tax: net GHS 50.00, VAT GHS 7.50, NHIL GHS 1.25, GETFund GHS 1.25. Six sales give net GHS 300.00, VAT GHS 45.00, NHIL GHS 7.50, GETFund GHS 7.50.

Figures for step 6.18 (today only, amounts in GHS):

| Account | Debits | Credits | What it is |
| --- | --- | --- | --- |
| 1200 Trade receivables | 7,190.00 | 7,190.00 | 50 sales at T1 (6,160.00) and 2 sales at T2 (1,030.00), all paid at once |
| 2100 Output VAT and levies payable | 0.00 | 60.00 | VAT 45.00, NHIL 7.50, GETFund 7.50, all from the six beef sales |
| 4000 Sales, live animals | 0.00 | 4,250.00 | Five goats at GHS 850.00 (four at T1 and G-0206 at T2) |
| 4010 Sales, meat | 0.00 | 300.00 | Six beef sales, net of tax |
| 4020 Sales, produce and eggs | 0.00 | 2,580.00 | 43 crates at GHS 60.00: 40 at T1 and 3 at T2 |
| 4210 Price variance | 0.00 | 0.00 | No price changes |

The credits add up to the receivables: 4,250.00 plus 300.00 plus 2,580.00 plus 60.00 is 7,190.00. Cost of sales and stock accounts for the goats (five at their seeded costs), beef and eggs also appear; for those, check only that the whole trial balance is balanced.

### Result

| Checkpoint | Steps | Pass or fail | Date | Tester | Evidence |
| --- | --- | --- | --- | --- | --- |
| Till kept selling offline; cash only; limits enforced | 6.3 to 6.7 | | | | |
| Provisional references 1 to 50, no gaps | 6.6 | | | | |
| Interrupted sync resumes with no duplicates | 6.8 to 6.10 | | | | |
| All 50 sales recorded once, official numbers consecutive | 6.9, 6.12 | | | | |
| Times: occurred and recorded both kept | 6.11 | | | | |
| Stock conflicts raised as four exceptions, not silently resolved | 6.13 to 6.15 | | | | |
| No money lost: cash close matches to the pesewa | 6.16, 6.17 | | | | |
| Books agree | 6.18 | | | | |

Notes: ____________________________________________

---

## 11. Scenario 7: disaster recovery

### Purpose

Prove that if the server is lost, last night's backup brings the system back with every figure intact, in the time the business can live with, and that you can show it. The targets are a **recovery point of 15 minutes** (at most the last 15 minutes of work may be lost) and a **recovery time of 4 hours** (back in service within 4 hours of the loss).

### Who runs it

The **administrator** does the technical restoration and follows the restore runbook written in session B13 (`docs/runbooks/`). The owner and the accountant watch, run the checks in the "Verify" section, and write down the times. This is the one scenario where the technical steps cannot be done by the tester; what the owner must be able to do, without a developer, is read the written runbook and verify the result.

### Setup

Staging with the starting facts loaded and at least one nightly backup taken. A clean second server (or the staging server emptied) to restore into. The key held offline by the owner (the sealed copy of the encryption key) is at hand.

### Steps

| # | Do this | You should see | Pass or fail |
| --- | --- | --- | --- |
| 7.1 | Write down the time of last night's backup: ______ . Efua opens the trial balance for 1 July to 30 September 2026 and the capital register | Net profit for the quarter GHS 41,666.70 (4,166,670 pesewas). Capital register: 4,200.0000 units, 42,000,000 pesewas (GHS 420,000.00). Write down the total debits shown for those three months: ______ | [ ] |
| 7.2 | Make a marker sale: Adwoa sells 1 crate of eggs for cash. Write down the receipt number and the exact time: ____ / ____ . Efua writes down the total number of orders on the system ______ and the audit chain head (the first 8 characters shown on the audit integrity page) ______ | Receipt issued | [ ] |
| 7.3 | Ten minutes after the marker sale, the administrator stops the staging server abruptly (power off, no clean shutdown). Write the time: ______ . This is the moment of "disaster". Start the clock | The system is unreachable | [ ] |
| 7.4 | The administrator brings up the clean environment and restores the latest base backup and the archived changes up to the last one available, following the runbook. The owner hands over the sealed key copy when asked | At each stage the runbook says what to expect. Write the time restoration of the data finished: ______ | [ ] |
| 7.5 | The administrator starts the application on the restored data. Write the time it answered: ______ | Staff can open the login page and the health page reports healthy | [ ] |
| 7.6 | **Verify (accountant and owner).** Efua opens the trial balance for 1 July to 30 September 2026 | Balanced: yes. Net profit GHS 41,666.70. Total debits equal the figure in 7.1 | [ ] |
| 7.7 | Open the capital register | 4,200.0000 units and GHS 420,000.00, as before | [ ] |
| 7.8 | Search for the marker sale by its receipt number | It exists with the right amount. The newest sale on the system is no more than 15 minutes older than the time in 7.3. Write down the newest sale's time: ______ . The difference from the time in 7.3 is ______ minutes (must be 15 or less) | [ ] |
| 7.9 | Open the audit integrity page | The chain verifies from the first event to the head. The head matches 7.2 (or is later, if later events were recovered) and the last off-server signed anchor agrees | [ ] |
| 7.10 | Akua opens an investor's payout details with a fresh code (for example Ama Owusu-Ansah's bank details) | The details are shown correctly, not garbled. This proves the encryption keys were restored | [ ] |
| 7.11 | Reprint the receipt from the marker sale and the Z report of any closed shift | Same number, same amounts, marked Reprint | [ ] |
| 7.12 | Make a new cash sale of one crate of eggs | It completes. The receipt number is the next one after the last restored receipt, with no gap and no repeated number | [ ] |
| 7.13 | Write down the time everything above passed: ______ . Work out the total: from the time in 7.3 to this time | Total time: ____ hours ____ minutes. **Four hours or less** is a pass | [ ] |

### Times to record

| Event | Time |
| --- | --- |
| Last backup taken | |
| Marker sale made | |
| Server stopped (disaster) | |
| Data restored | |
| Application answering | |
| All checks passed | |
| Total from disaster to all checks passed | |
| Gap between newest restored sale and the disaster | |

### Result

| Checkpoint | Steps | Pass or fail | Date | Tester | Evidence |
| --- | --- | --- | --- | --- | --- |
| Restored without developer improvisation, from the runbook | 7.4, 7.5 | | | | |
| Trial balance and capital register identical | 7.6, 7.7 | | | | |
| Nothing older than 15 minutes lost | 7.8 | | | | |
| Audit chain intact | 7.9 | | | | |
| Encrypted data readable with the owner's key | 7.10 | | | | |
| Documents reprint; numbering continues without gap or repeat | 7.11, 7.12 | | | | |
| Total time within four hours | 7.13 | | | | |

Notes: ____________________________________________

---

## 12. Sign-off

| Scenario | Passed | Date | Tester | Owner's initials |
| --- | --- | --- | --- | --- |
| 1. A full trading day | | | | |
| 2. Quote to cash | | | | |
| 3. Traceability | | | | |
| 4. Investor distribution | | | | |
| 5. Fraud attempts | | | | |
| 6. Offline counter | | | | |
| 7. Disaster recovery | | | | |

The system is accepted for launch when all seven are marked Passed, in a run where no step needed a developer to tell the tester what to do next. A scenario with any failed step is not passed; the failures are listed with their evidence for the developer, fixed, and the whole scenario is run again from its setup.

Owner: ______________________   Date: ______________
