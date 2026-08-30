/**
 * Seed dataset for the Business Management App.
 *
 * Extracted verbatim from the imported Claude Design project by
 * `tools/extract-seed.mjs`. This module is the only place record data lives;
 * everything reaches it through `src/data/repository.js`, which is the seam a
 * real HTTP API would replace.
 */

export const COMPANY = {name:'Meghna Agro Enterprise', sys:'Business Suite', fy:'FY 2026-27', user:'Rakib Hasan', init:'RH'};

export const NAV = [
    {g:'Overview', items:[{id:'dashboard', label:'Dashboard', icon:'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v3H9zM9 7.5h4.5v6H9zM2.5 9.5h4.5v4H2.5z', roles:'*'}]},
    {g:'Bulk Crop Trading', items:[
      {id:'crop-purchase', label:'Crop Purchase', icon:'M8 2v6m0 0 2.5-2.5M8 8 5.5 5.5M2.5 10v3.5h11V10', roles:['Admin','Management','Purchase','Warehouse']},
      {id:'crop-sales', label:'Crop Sales', icon:'M8 8V2m0 0 2.5 2.5M8 2 5.5 4.5M2.5 10v3.5h11V10', roles:['Admin','Management','Sales']}]},
    {g:'Dealer Business', items:[
      {id:'dealer-purchase', label:'Dealer Purchase', icon:'M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3zM2.5 5.5 8 8.5l5.5-3M8 8.5v5', roles:['Admin','Management','Purchase','Warehouse']},
      {id:'dealer-sales', label:'Dealer Sales', icon:'M8.5 2H13v4.5L7 12.5 2.5 8zM10.6 4.4h.01', roles:['Admin','Management','Sales']}]},
    {g:'Operations', items:[
      {id:'inventory', label:'Inventory', icon:'M2.5 4h11v9.5h-11zM2.5 7h11M6 4V2.5h4V4', roles:['Admin','Management','Purchase','Warehouse','Sales']},
      {id:'customers', label:'Customers', icon:'M6 7.5a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5zM1.75 13.5c0-2.3 1.9-3.75 4.25-3.75s4.25 1.45 4.25 3.75M11 3.5a2.25 2.25 0 010 4.25M12.25 13.5c0-1.4-.4-2.4-1.2-3', roles:['Admin','Management','Sales','Accounts']},
      {id:'suppliers', label:'Suppliers / Farmers', icon:'M13.5 2.5C7 2.5 3.5 5.5 3.5 10c0 1 .3 1.7.3 1.7 4.7 0 9.7-3.2 9.7-9.2zM3.8 11.7 2 13.5', roles:['Admin','Management','Purchase','Accounts']},
      {id:'companies', label:'Companies', icon:'M3 13.5V3h6v10.5M9 6.5h4v7M5 5.5h2M5 8h2M5 10.5h2M1.5 13.5h13', roles:['Admin','Management','Purchase','Accounts']},
      {id:'warehouses', label:'Warehouses', icon:'M2.5 6.5 8 3l5.5 3.5v7h-11zM6 13.5V9h4v4.5', roles:['Admin','Management','Purchase','Warehouse','Accounts']},
      {id:'products', label:'Products', icon:'M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3zM2.5 5.5 8 8.5l5.5-3M8 8.5v5', roles:['Admin','Management','Purchase','Sales','Warehouse','Accounts']},
      {id:'crops', label:'Crops', icon:'M8 14V7.5M8 7.5C8 5 6.2 3 3.5 2.5 3 5.2 5 7.3 8 7.5zM8 9.2c.2-2.2 2-4 4.5-4.4.4 2.4-1.4 4.3-4.5 4.4z', roles:['Admin','Management','Purchase','Sales','Warehouse','Accounts']}]},
    {g:'Finance', items:[
      {id:'accounts', label:'Accounts & Outstanding', icon:'M2 4.5h11.5v9H2zM2 4.5 11 2v2.5M10 9h2.5', roles:['Admin','Management','Accounts']},
      {id:'approvals', label:'Approvals', icon:'M8 14A6 6 0 108 2a6 6 0 000 12zM5.5 8.2l1.9 1.9 3.3-3.8', roles:['Admin','Management','Accounts']}]},
    {g:'Insight', items:[{id:'reports', label:'Reports Centre', icon:'M2.5 13.5h11M4.5 11V6.5M8 11V3M11.5 11V8', roles:'*'}]},
    {g:'System', items:[
      {id:'settings', label:'Settings', icon:'M8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM8 1.8v1.8M8 12.4v1.8M2.2 8h1.8M12 8h1.8M3.9 3.9l1.3 1.3M10.8 10.8l1.3 1.3M12.1 3.9l-1.3 1.3M5.2 10.8 3.9 12.1', roles:['Admin','Management']},
      {id:'employees', label:'Employees', icon:'M8 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4', roles:['Admin','Management']},
      {id:'audit', label:'Audit Trail', icon:'M4 2h8v12H4zM6 5h4M6 8h4M6 11h2.5', roles:['Admin','Management','Accounts']},
      {id:'mobile', label:'Mobile Screens', icon:'M5 1.5h6v13H5zM7 12.8h2', roles:'*'}]}
  ];

export const TITLES = {dashboard:['Business Overview','Consolidated position across both business models'],
    'crop-purchase':['Bulk Crop Purchase','Farmer / supplier procurement with landed cost'],
    'crop-sales':['Bulk Crop Sales','Batch-wise sale to buyer companies'],
    'dealer-purchase':['Dealer Purchase','Stock intake from principal companies'],
    'dealer-sales':['Dealer Sales','Invoice to dealers, retailers and corporates'],
    inventory:['Inventory & Batch Stock','Unified stock across warehouses'],
    customers:['Customers','Dealer, retailer and corporate master'],
    suppliers:['Suppliers & Farmers','Procurement party master'],
    companies:['Companies','Principal, supplier and buyer companies'],
    crops:['Crops','What the bulk trading side buys, stores and sells'],
    products:['Products','Dealer catalogue: agrochemical, fertiliser, seed and feed'],
    warehouses:['Warehouses','Godowns and depots that hold stock'],
    accounts:['Accounts & Outstanding','Receivable, payable, cash and profitability'],
    approvals:['Approval Queue','Transactions waiting on authorisation'],
    reports:['Reports Centre','Filterable reports across both business types'],
    settings:['Settings','Company, numbering, limits and permissions'],
    employees:['Employees','Team directory and system roles'],
    audit:['Audit Trail','Every change, with before and after values'],
    mobile:['Mobile Screens','Field entry and approval on a phone']};

export const CUSTOMERS = [
    {code:'CUS-001', name:'Messrs. Rahman Traders', bn:'মেসার্স রহমান ট্রেডার্স', type:'Dealer', person:'Abdur Rahman', mobile:'01712-335566', district:'Rangpur', upazila:'Badarganj', limit:1500000, days:21, sales:4820000, coll:4100000, out:720000, last:'26 Aug 2026', b30:410000, b60:210000, b90:100000, b90p:0},
    {code:'CUS-002', name:'Bhai Bhai Agro Store', bn:'ভাই ভাই এগ্রো স্টোর', type:'Retailer', person:'Md. Jahangir Alam', mobile:'01815-772130', district:'Bogura', upazila:'Sherpur', limit:800000, days:15, sales:2960000, coll:2610000, out:350000, last:'27 Aug 2026', b30:240000, b60:110000, b90:0, b90p:0},
    {code:'CUS-003', name:'Nabin Krishi Bitan', bn:'নবীন কৃষি বিতান', type:'Dealer', person:'Shahin Mia', mobile:'01911-450288', district:'Naogaon', upazila:'Mohadevpur', limit:1200000, days:21, sales:3740000, coll:2890000, out:850000, last:'24 Aug 2026', b30:300000, b60:250000, b90:200000, b90p:100000},
    {code:'CUS-004', name:'Sonar Bangla Enterprise', bn:'সোনার বাংলা এন্টারপ্রাইজ', type:'Corporate', person:'Kamrul Hasan', mobile:'01733-661209', district:'Dinajpur', upazila:'Birampur', limit:2500000, days:30, sales:6180000, coll:5560000, out:620000, last:'27 Aug 2026', b30:620000, b60:0, b90:0, b90p:0},
    {code:'CUS-005', name:'Jashore Agro Centre', bn:'যশোর এগ্রো সেন্টার', type:'Retailer', person:'Nazrul Islam', mobile:'01677-903455', district:'Jashore', upazila:'Jhikargachha', limit:600000, days:15, sales:1840000, coll:1520000, out:320000, last:'21 Aug 2026', b30:120000, b60:80000, b90:120000, b90p:0},
    {code:'CUS-006', name:'Uttara Seed House', bn:'উত্তরা সীড হাউস', type:'Dealer', person:'Rafiqul Bari', mobile:'01521-330817', district:'Rangpur', upazila:'Mithapukur', limit:900000, days:21, sales:2410000, coll:2170000, out:240000, last:'25 Aug 2026', b30:180000, b60:60000, b90:0, b90p:0}
  ];

export const SUPPLIERS = [
    {code:'SUP-001', name:'Abdul Karim Mondol', bn:'আব্দুল করিম মন্ডল', type:'Farmer', mobile:'01718-224509', district:'Naogaon', upazila:'Mohadevpur', bank:'bKash 01718-224509', pur:8420000, paid:7900000, out:520000, last:'26 Aug 2026'},
    {code:'SUP-002', name:'Jashim Uddin Sarkar', bn:'জসিম উদ্দিন সরকার', type:'Aratdar', mobile:'01812-667341', district:'Dinajpur', upazila:'Birampur', bank:'Islami Bank 20501...4417', pur:12650000, paid:11980000, out:670000, last:'27 Aug 2026'},
    {code:'SUP-003', name:'Aftab Ali Bepari', bn:'আফতাব আলী বেপারী', type:'Trader', mobile:'01933-118240', district:'Bogura', upazila:'Shibganj', bank:'Nagad 01933-118240', pur:6180000, paid:6180000, out:0, last:'19 Aug 2026'},
    {code:'SUP-004', name:'Nurul Haque Krishi Khamar', bn:'নুরুল হক কৃষি খামার', type:'Farm', mobile:'01755-902611', district:'Rangpur', upazila:'Gangachara', bank:'DBBL 1471...8802', pur:4390000, paid:3990000, out:400000, last:'23 Aug 2026'},
    {code:'SUP-005', name:'Shahida Begum', bn:'শাহিদা বেগম', type:'Farmer', mobile:'01640-773125', district:'Jashore', upazila:'Manirampur', bank:'bKash 01640-773125', pur:1870000, paid:1570000, out:300000, last:'20 Aug 2026'}
  ];

export const COMPANIES = [
    {code:'CMP-01', name:'ACI Agrochemicals Ltd.', type:'Principal', person:'Md. Shafiqul Islam', mobile:'01711-204588', district:'Dhaka', limit:2500000, days:30, bal:1840000, status:'Active'},
    {code:'CMP-02', name:'Syngenta Bangladesh Ltd.', type:'Principal', person:'Tanvir Ahmed', mobile:'01730-556018', district:'Dhaka', limit:2000000, days:30, bal:0, status:'Active'},
    {code:'CMP-03', name:'Ispahani Agro Ltd.', type:'Supplier', person:'Golam Mostafa', mobile:'01819-337265', district:'Chattogram', limit:1200000, days:21, bal:300000, status:'Active'},
    {code:'CMP-04', name:'PRAN Agro Business Ltd.', type:'Buyer', person:'Sabbir Rahman', mobile:'01777-880412', district:'Natore', limit:0, days:14, bal:-2450000, status:'Active'},
    {code:'CMP-05', name:'City Group (Rice Unit)', type:'Buyer', person:'Anisur Rahman', mobile:'01709-114523', district:'Narayanganj', limit:0, days:10, bal:-1820000, status:'Active'},
    {code:'CMP-06', name:'Akij Foods & Beverage Ltd.', type:'Supplier & Buyer', person:'Mahbub Alam', mobile:'01755-220149', district:'Dhaka', limit:900000, days:21, bal:-680000, status:'Active'},
    {code:'CMP-07', name:'Square Feeds Ltd.', type:'Supplier & Buyer', person:'Sadia Afrin', mobile:'01711-908844', district:'Gazipur', limit:1500000, days:30, bal:410000, status:'On hold'}
  ];

export const PRODUCTS = [
    {code:'P-1001', name:'Ridomil Gold MZ 72 WP 100g', cat:'Agrochemical', brand:'Syngenta', unit:'Pcs', stock:1840, pur:245, sale:295, min:400},
    {code:'P-1002', name:'Virtako 40 WG 30g', cat:'Agrochemical', brand:'Syngenta', unit:'Pcs', stock:960, pur:318, sale:385, min:300},
    {code:'P-1003', name:'ACI Zinc Sulphate 1kg', cat:'Fertilizer', brand:'ACI', unit:'Pcs', stock:210, pur:180, sale:225, min:250},
    {code:'P-1004', name:'Hybrid Maize Seed NK-40 1kg', cat:'Seeds', brand:'Syngenta', unit:'Kg', stock:640, pur:420, sale:510, min:200},
    {code:'P-1005', name:'Square Layer Grower Feed 50kg', cat:'Feed', brand:'Square', unit:'Bag', stock:118, pur:2380, sale:2560, min:60},
    {code:'P-1006', name:'Ispahani TSP Fertilizer 50kg', cat:'Fertilizer', brand:'Ispahani', unit:'Bag', stock:74, pur:1650, sale:1780, min:120}
  ];

export const CROPS = ['Maize', 'Paddy (BRRI-28)', 'Rice (Miniket)', 'Wheat', 'Potato', 'Onion'];

export const WAREHOUSES = ['Naogaon Central Godown', 'Bogura Depot', 'Rangpur Store', 'Dinajpur Godown'];

export const UNITS = ['MT', 'Maund', 'Kg', 'Bag'];

export const GRADES = ['A (Premium)', 'B (Standard)', 'C (Feed grade)'];

export const BUYERS = ['PRAN Agro Business Ltd.', 'City Group (Rice Unit)', 'Akij Foods & Beverage Ltd.', 'Square Feeds Ltd.'];

export const LAST_RATE = {'Maize':30500, 'Paddy (BRRI-28)':26400, 'Rice (Miniket)':58200, 'Wheat':34800, 'Potato':21500, 'Onion':46000};

export const BATCHES = [
      {id:'BC-2608-011', crop:'Maize', grade:'A (Premium)', wh:'Naogaon Central Godown', qty:100, rem:62, cost:30800, date:'12 Aug 2026', age:16, sup:'Abdul Karim Mondol'},
      {id:'BC-2608-009', crop:'Maize', grade:'B (Standard)', wh:'Bogura Depot', qty:60, rem:60, cost:29450, date:'08 Aug 2026', age:20, sup:'Aftab Ali Bepari'},
      {id:'BC-2607-014', crop:'Paddy (BRRI-28)', grade:'A (Premium)', wh:'Naogaon Central Godown', qty:250, rem:88, cost:26200, date:'22 Jul 2026', age:37, sup:'Jashim Uddin Sarkar'},
      {id:'BC-2607-008', crop:'Rice (Miniket)', grade:'A (Premium)', wh:'Dinajpur Godown', qty:120, rem:45, cost:57400, date:'15 Jul 2026', age:44, sup:'Jashim Uddin Sarkar'},
      {id:'BC-2607-002', crop:'Potato', grade:'B (Standard)', wh:'Rangpur Store', qty:180, rem:96, cost:20900, date:'04 Jul 2026', age:55, sup:'Nurul Haque Krishi Khamar'},
      {id:'BC-2606-001', crop:'Onion', grade:'C (Feed grade)', wh:'Jashore Cold Store', qty:40, rem:14, cost:45800, date:'16 Jun 2026', age:73, sup:'Shahida Begum'}
    ];

export const APPROVALS = [
      {id:'AP-1043', kind:'Bulk Crop Purchase', ref:'PC-2608-014', party:'Abdul Karim Mondol', amt:3020000, by:'Sohel Rana (Purchase)', when:'28 Aug, 10:12 am', why:'Purchase value above ৳5,00,000 limit', status:'pending', hist:''},
      {id:'AP-1042', kind:'Sales Discount', ref:'DS-2608-221', party:'Nabin Krishi Bitan', amt:86400, by:'Shamim Reza (Sales)', when:'28 Aug, 9:40 am', why:'Discount 6.5% exceeds 5% ceiling', status:'pending', hist:''},
      {id:'AP-1041', kind:'Stock Adjustment', ref:'ADJ-2608-030', party:'Naogaon Central Godown', amt:124000, by:'Jamal Uddin (Warehouse)', when:'27 Aug, 6:05 pm', why:'Weight loss 4 MT on Paddy batch BC-2607-014', status:'pending', hist:''},
      {id:'AP-1040', kind:'Expense', ref:'EXP-2608-118', party:'Transport — Dinajpur trip', amt:96000, by:'Nasrin Akter (Accounts)', when:'27 Aug, 3:22 pm', why:'Expense above ৳50,000 limit', status:'pending', hist:''},
      {id:'AP-1039', kind:'Bulk Crop Sales', ref:'SC-2608-051', party:'City Group (Rice Unit)', amt:2760000, by:'Shamim Reza (Sales)', when:'26 Aug, 11:50 am', why:'Credit sale to buyer above ৳20,00,000', status:'approved', hist:'Approved by Rakib Hasan · 26 Aug, 12:15 pm'},
      {id:'AP-1038', kind:'Sales Discount', ref:'DS-2608-198', party:'Jashore Agro Centre', amt:42000, by:'Shamim Reza (Sales)', when:'25 Aug, 4:10 pm', why:'Discount 8% exceeds 5% ceiling', status:'rejected', hist:'Rejected by Rakib Hasan · 25 Aug, 5:02 pm — margin below floor'}
    ];

export const CROP_LOG = [
      {no:'PC-2608-013', date:'26 Aug 2026', sup:'Abdul Karim Mondol', crop:'Maize', qty:100, unit:'MT', rate:30000, cpu:30800, total:3080000, status:'Posted'},
      {no:'PC-2608-012', date:'24 Aug 2026', sup:'Jashim Uddin Sarkar', crop:'Paddy (BRRI-28)', qty:150, unit:'MT', rate:25800, cpu:26200, total:3930000, status:'Posted'},
      {no:'PC-2608-010', date:'21 Aug 2026', sup:'Nurul Haque Krishi Khamar', crop:'Potato', qty:80, unit:'MT', rate:20400, cpu:20900, total:1672000, status:'Posted'},
      {no:'PC-2608-009', date:'19 Aug 2026', sup:'Aftab Ali Bepari', crop:'Maize', qty:60, unit:'MT', rate:29100, cpu:29450, total:1767000, status:'Posted'},
      {no:'PC-2608-008', date:'17 Aug 2026', sup:'Shahida Begum', crop:'Onion', qty:22, unit:'MT', rate:45200, cpu:45800, total:1007600, status:'Draft'}
    ];

export const SALE_LOG = [
      {no:'SC-2608-051', date:'26 Aug 2026', buyer:'City Group (Rice Unit)', crop:'Rice (Miniket)', batch:'BC-2607-008', qty:48, rate:61500, amt:2952000, profit:171200, status:'Posted'},
      {no:'SC-2608-049', date:'24 Aug 2026', buyer:'PRAN Agro Business Ltd.', crop:'Maize', batch:'BC-2608-011', qty:38, rate:34500, amt:1311000, profit:120600, status:'Posted'},
      {no:'SC-2608-047', date:'22 Aug 2026', buyer:'Square Feeds Ltd.', crop:'Maize', batch:'BC-2608-009', qty:25, rate:33200, amt:830000, profit:78750, status:'Posted'},
      {no:'SC-2608-045', date:'20 Aug 2026', buyer:'Akij Foods & Beverage Ltd.', crop:'Potato', batch:'BC-2607-002', qty:84, rate:22600, amt:1898400, profit:118400, status:'Posted'}
    ];

export const NOTIFICATIONS = [
      {t:'Payment overdue', d:'Nabin Krishi Bitan — ৳1,00,000 past 90 days', ago:'12m', tone:'danger', go:'accounts'},
      {t:'Approval pending', d:'Crop purchase PC-2608-014 needs your approval', ago:'48m', tone:'accent', go:'approvals'},
      {t:'Low stock', d:'Ispahani TSP 50kg — 74 bags against minimum 120', ago:'2h', tone:'warn', go:'inventory'},
      {t:'Dead stock alert', d:'Onion batch BC-2606-001 is 73 days old', ago:'5h', tone:'warn', go:'inventory'},
      {t:'Supplier payment due', d:'Jashim Uddin Sarkar — ৳6,70,000 due 30 Aug', ago:'8h', tone:'accent', go:'accounts'},
      {t:'Large transaction', d:'Crop sale SC-2608-051 posted at ৳29,52,000', ago:'1d', tone:'ok', go:'crop-sales'}
    ];
