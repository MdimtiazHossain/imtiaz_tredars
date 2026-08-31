import { field, formModal } from '../components/formModal.js';

/**
 * Master data forms: crops, products, customers, suppliers and companies.
 *
 * Same shape as `transactionForms.js` -- each entity is described once and the
 * modal is built from the description, so every master screen shares one form,
 * one validator and one submit path rather than a copy each.
 *
 * The lists an operator picks from (party types, districts, units) come from
 * the data already loaded, not from constants here. A district that exists
 * only because someone typed it into a supplier record still turns up in the
 * next form, and the app never offers a unit the server would reject.
 */

/**
 * The names on a maintained list, falling back to what is already in use.
 *
 * The maintained list is the answer once there is one; the fallback keeps the
 * form working before the settings payload has arrived, and in the no-backend
 * demo where the two lists are not kept separately.
 */
function named(rows, fallback) {
  const names = (rows || []).filter((r) => r.active !== false).map((r) => r.name);
  return names.length ? names : fallback;
}

/** Options that exist in the data, plus the value being edited, sorted. */
function optionsFrom(rows, key, extra) {
  const seen = new Set();
  (rows || []).forEach((r) => {
    const v = r && r[key];
    if (v) seen.add(String(v));
  });
  if (extra) seen.add(String(extra));
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * The party types on offer.
 *
 * Seeded from what the data already uses so the list reflects this business,
 * with a small set of common ones so a first-ever record still has something
 * to choose from.
 */
const SEED_TYPES = {
  customer: ['Dealer', 'Retailer', 'Corporate', 'Individual'],
  supplier: ['Farmer', 'Aratdar', 'Trader', 'Farm'],
};

const COMPANY_ROLES = [
  { value: 'PRINCIPAL', label: 'Principal' },
  { value: 'SUPPLIER', label: 'Supplier' },
  { value: 'BUYER', label: 'Buyer' },
  { value: 'SUPPLIER_AND_BUYER', label: 'Supplier and buyer' },
];

export const MASTER_KINDS = [
  'crop', 'product', 'customer', 'supplier', 'company', 'warehouse', 'employee',
  'account', 'category', 'method', 'unit', 'productCategory', 'brand',
];

const TITLES = {
  crop: ['crop', 'Crops are what the bulk trading side buys, stores and sells'],
  product: ['product', 'Agrochemicals, fertiliser, seed and feed sold through dealers'],
  customer: ['customer', 'Dealers, retailers and corporate buyers'],
  supplier: ['supplier', 'Farmers, aratdars and traders you buy from'],
  company: ['company', 'Principals, supplier companies and buyer companies'],
  warehouse: ['warehouse', 'Godowns and depots that hold stock'],
  employee: ['employee', 'The team, and the department each one belongs to'],
  account: ['account', 'Cash, bank and mobile money the business holds'],
  category: ['expense category', 'What spending is booked against'],
  method: ['payment method', 'How money is taken in and paid out'],
  unit: ['unit', 'How quantities are measured, and what they convert to'],
  productCategory: ['product category', 'What the dealer catalogue is grouped by'],
  brand: ['brand', 'Whose product it is — the maker, not the supplier'],
};

/** What one record of this kind is called, for a title or a message. */
export function nounFor(kind) {
  return (TITLES[kind] || [kind])[0];
}

/** The empty form for a new record, or the values of the one being edited. */
export function defaultsFor(kind, data, row) {
  const districts = optionsFrom(
    (data.customers || []).concat(data.suppliers || []),
    'district'
  );
  const firstDistrict = districts[0] || '';

  if (kind === 'crop') {
    return {
      name: row ? row.name : '',
      unit: row ? row.unit || (data.units || [])[0] : (data.units || [])[0] || 'MT',
      rate: row ? row.rate : '',
    };
  }

  if (kind === 'warehouse') {
    return {
      name: row ? row.name : '',
      district: row ? row.district : firstDistrict,
    };
  }

  if (kind === 'account') {
    return {
      code: row ? row.code : '',
      name: row ? row.name : '',
      type: row ? row.type : 'CASH',
      opening: row ? row.opening : '',
    };
  }

  if (kind === 'category' || kind === 'productCategory' || kind === 'brand') {
    return { code: row ? row.code : '', name: row ? row.name : '' };
  }

  if (kind === 'method') {
    return {
      code: row ? row.code : '',
      name: row ? row.name : '',
      account: row ? row.account : '',
    };
  }

  if (kind === 'unit') {
    return {
      code: row ? row.code : '',
      name: row ? row.name : '',
      // A new unit is assumed to be a fraction of the base one, which is what
      // every unit after the first has been.
      base: row ? row.base || '' : (data.units || [])[0] || '',
      factor: row ? row.factor : '',
    };
  }

  if (kind === 'employee') {
    return {
      name: row ? row.name : '',
      designation: row ? row.designation : '',
      department: row ? row.department : optionsFrom(data.employees, 'department')[0] || '',
      mobile: row ? row.mobile : '',
      joined: row ? row.joined : '',
    };
  }

  if (kind === 'product') {
    return {
      name: row ? row.name : '',
      cat: row ? row.cat : optionsFrom(data.products, 'cat')[0] || '',
      brand: row ? row.brand : optionsFrom(data.products, 'brand')[0] || '',
      unit: row ? row.unit : (data.units || [])[0] || 'Pcs',
      pur: row ? row.pur : '',
      sale: row ? row.sale : '',
      min: row ? row.min : '',
    };
  }

  if (kind === 'company') {
    return {
      name: row ? row.name : '',
      role: row ? row.role || 'SUPPLIER' : 'SUPPLIER',
      person: row ? row.person : '',
      mobile: row ? row.mobile : '',
      district: row ? row.district : firstDistrict,
      limit: row ? row.limit : '',
      days: row ? row.days : '',
    };
  }

  if (kind === 'supplier') {
    return {
      name: row ? row.name : '',
      bn: row ? row.bn : '',
      type: row ? row.type : SEED_TYPES.supplier[0],
      mobile: row ? row.mobile : '',
      district: row ? row.district : firstDistrict,
      upazila: row ? row.upazila : '',
      bank: row ? row.bank : '',
      opening: row ? '' : '',
    };
  }

  return {
    name: row ? row.name : '',
    bn: row ? row.bn : '',
    type: row ? row.type : SEED_TYPES.customer[0],
    person: row ? row.person : '',
    mobile: row ? row.mobile : '',
    district: row ? row.district : firstDistrict,
    upazila: row ? row.upazila : '',
    limit: row ? row.limit : '',
    days: row ? row.days : '',
    opening: '',
  };
}

/** The fields the modal shows, in the order they read. */
export function fieldsFor(kind, form, data, on, row) {
  const districts = optionsFrom(
    (data.customers || []).concat(data.suppliers || []).concat(data.companies || []),
    'district',
    form.district
  );

  if (kind === 'crop') {
    return [
      field('name', 'Crop name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Paddy (BRRI-28)',
        wide: true,
      }),
      field('unit', 'Default unit', {
        options: data.units || [],
        value: form.unit,
        onChange: on('unit'),
        hint: 'How this crop is bought, stored and sold',
      }),
      field('rate', 'Last known rate', {
        type: 'number',
        value: form.rate,
        onChange: on('rate'),
        placeholder: '0',
        hint: 'Used as the opening suggestion on a purchase',
      }),
    ];
  }

  if (kind === 'account') {
    return [
      field('name', 'Account name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Islami Bank — 20501...4417',
        wide: true,
      }),
      field('type', 'Kind', {
        options: [
          { value: 'CASH', label: 'Cash' },
          { value: 'BANK', label: 'Bank' },
          { value: 'MFS', label: 'Mobile money' },
        ],
        value: form.type,
        onChange: on('type'),
      }),
      // The code goes on statements and reports, so it is worth choosing.
      field('code', 'Code', {
        value: form.code,
        onChange: on('code'),
        mono: true,
        placeholder: 'BANK-IBBL',
        hint: row ? 'Changing this changes how the account is referenced' : 'Optional — one is allocated if left blank',
      }),
      // An opening balance is what was in the account on the day it was added,
      // so it only makes sense while creating one.
      ...(row
        ? []
        : [
            field('opening', 'Opening balance', {
              type: 'number',
              value: form.opening,
              onChange: on('opening'),
              placeholder: '0',
            }),
          ]),
    ];
  }

  if (kind === 'method') {
    return [
      field('name', 'Method name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'bKash',
        wide: true,
      }),
      // Where the money lands. Optional, because a method can be set up before
      // the account it pays into exists.
      field('account', 'Pays into', {
        options: [''].concat((data.accounts || []).map((a) => a.name)),
        value: form.account,
        onChange: on('account'),
        hint: 'Leave blank if it is not settled yet',
      }),
      field('code', 'Code', {
        value: form.code,
        onChange: on('code'),
        mono: true,
        placeholder: 'BKASH',
        hint: 'Optional — one is allocated if left blank',
      }),
    ];
  }

  if (kind === 'unit') {
    // Only a unit that is a base itself can be another unit's base, so the
    // list offers the ones with no base of their own.
    const bases = (data.unitRecords || [])
      .filter((u) => !u.base && u.code !== form.code)
      .map((u) => u.code);
    return [
      field('name', 'Unit name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Quintal',
        wide: true,
      }),
      field('code', 'Short code', {
        value: form.code,
        onChange: on('code'),
        mono: true,
        placeholder: 'Qtl',
        hint: row ? 'This is how the unit reads on every document' : 'How it reads on a document',
      }),
      field('base', 'Measured against', {
        options: [''].concat(bases),
        value: form.base,
        onChange: on('base'),
        hint: 'Leave blank if this is a base unit in its own right',
      }),
      field('factor', 'One of these is', {
        type: 'number',
        value: form.factor,
        onChange: on('factor'),
        placeholder: '0.1',
        hint: form.base
          ? `How many ${form.base} one ${form.code || 'unit'} is worth — 1 Kg is 0.001 MT`
          : 'A base unit is worth one of itself',
      }),
    ];
  }

  if (kind === 'productCategory' || kind === 'brand') {
    const noun = kind === 'brand' ? 'Brand' : 'Category';
    return [
      field('name', `${noun} name`, {
        value: form.name,
        onChange: on('name'),
        placeholder: kind === 'brand' ? 'Syngenta' : 'Agrochemical',
        wide: true,
      }),
      field('code', 'Code', {
        value: form.code,
        onChange: on('code'),
        mono: true,
        placeholder: kind === 'brand' ? 'SYNGENTA' : 'AGROCHEMICAL',
        hint: 'Optional — one is allocated if left blank',
      }),
    ];
  }

  if (kind === 'category') {
    return [
      field('name', 'Category name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Office & utility',
        wide: true,
      }),
      field('code', 'Code', {
        value: form.code,
        onChange: on('code'),
        mono: true,
        placeholder: 'OFFICE_UTILITY',
        hint: 'Optional — one is allocated if left blank',
      }),
    ];
  }

  if (kind === 'warehouse') {
    return [
      field('name', 'Warehouse name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Naogaon Central Godown',
        wide: true,
      }),
      field('district', 'District', {
        suggestions: districts,
        value: form.district,
        onChange: on('district'),
        placeholder: 'Bogura',
      }),
    ];
  }

  if (kind === 'employee') {
    return [
      field('name', 'Name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Tanvir Ahmed',
        wide: true,
      }),
      field('designation', 'Designation', {
        value: form.designation,
        onChange: on('designation'),
        placeholder: 'Warehouse Assistant',
      }),
      // Departments are the ones that exist; the server refuses an unknown one
      // rather than inventing a department nobody set up.
      field('department', 'Department', {
        options: optionsFrom(data.employees, 'department', form.department),
        value: form.department,
        onChange: on('department'),
      }),
      field('mobile', 'Mobile', { value: form.mobile, onChange: on('mobile'), mono: true }),
      field('joined', 'Joined on', {
        type: 'date',
        value: form.joined,
        onChange: on('joined'),
        hint: 'Leave blank if it is not known',
      }),
    ];
  }

  if (kind === 'product') {
    return [
      field('name', 'Product name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Ridomil Gold MZ 72 WP 100g',
        wide: true,
      }),
      // Categories and brands are the ones the catalogue already uses; the
      // server refuses an unknown one rather than quietly inventing it.
      // The categories and brands that have been set up. Blank is offered
      // first because both are optional, and because a catalogue that has not
      // been classified yet is a real state rather than an error.
      field('cat', 'Category', {
        options: [''].concat(
          named(data.productCategories, optionsFrom(data.products, 'cat', form.cat))
        ),
        value: form.cat,
        onChange: on('cat'),
        hint: 'Set them up under Settings › Categories & brands',
      }),
      field('brand', 'Brand', {
        options: [''].concat(named(data.brands, optionsFrom(data.products, 'brand', form.brand))),
        value: form.brand,
        onChange: on('brand'),
      }),
      field('unit', 'Unit', {
        options: data.units || [],
        value: form.unit,
        onChange: on('unit'),
      }),
      field('pur', 'Purchase rate', {
        type: 'number', value: form.pur, onChange: on('pur'), placeholder: '0',
      }),
      field('sale', 'Sale rate', {
        type: 'number', value: form.sale, onChange: on('sale'), placeholder: '0',
      }),
      field('min', 'Minimum stock', {
        type: 'number', value: form.min, onChange: on('min'), placeholder: '0',
        hint: 'Below this the product is flagged as low stock',
      }),
    ];
  }

  if (kind === 'company') {
    return [
      field('name', 'Company name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'ACI Agrochemicals Ltd.',
        wide: true,
      }),
      field('role', 'Role', {
        options: COMPANY_ROLES,
        value: form.role,
        onChange: on('role'),
        hint: 'A company can both supply and buy',
      }),
      field('person', 'Contact person', { value: form.person, onChange: on('person') }),
      field('mobile', 'Mobile', { value: form.mobile, onChange: on('mobile'), mono: true }),
      field('district', 'District', {
        suggestions: districts,
        value: form.district,
        onChange: on('district'),
        placeholder: 'Bogura',
      }),
      field('limit', 'Credit limit', {
        type: 'number',
        value: form.limit,
        onChange: on('limit'),
        placeholder: '0',
      }),
      field('days', 'Credit days', {
        type: 'number',
        value: form.days,
        onChange: on('days'),
        placeholder: '0',
      }),
    ];
  }

  const isSupplier = kind === 'supplier';
  const types = optionsFrom(
    isSupplier ? data.suppliers : data.customers,
    'type',
    form.type
  );
  SEED_TYPES[kind].forEach((t) => {
    if (types.indexOf(t) === -1) types.push(t);
  });
  types.sort((a, b) => a.localeCompare(b));

  const common = [
    field('name', 'Name', {
      value: form.name,
      onChange: on('name'),
      placeholder: isSupplier ? 'Abdul Karim Mondol' : 'Messrs. Rahman Traders',
      wide: true,
    }),
    field('bn', 'Name in Bangla', {
      value: form.bn,
      onChange: on('bn'),
      placeholder: 'ঐচ্ছিক',
      wide: true,
    }),
    field('type', isSupplier ? 'Supplier type' : 'Customer type', {
      options: types,
      value: form.type,
      onChange: on('type'),
    }),
    field('mobile', 'Mobile', {
      value: form.mobile,
      onChange: on('mobile'),
      mono: true,
      placeholder: '017XXXXXXXX',
    }),
    field('district', 'District', {
      suggestions: districts,
      value: form.district,
      onChange: on('district'),
      placeholder: 'Bogura',
    }),
    field('upazila', 'Upazila', { value: form.upazila, onChange: on('upazila') }),
  ];

  if (isSupplier) {
    common.push(
      field('bank', 'Bank account', {
        value: form.bank,
        onChange: on('bank'),
        mono: true,
        placeholder: 'Optional',
      })
    );
  } else {
    common.push(
      field('limit', 'Credit limit', {
        type: 'number',
        value: form.limit,
        onChange: on('limit'),
        placeholder: '0',
      }),
      field('days', 'Credit days', {
        type: 'number',
        value: form.days,
        onChange: on('days'),
        placeholder: '0',
      })
    );
  }

  // An opening balance is what the party already owed on the day they were
  // added, so it only makes sense while creating one.
  if (!row) {
    common.push(
      field('opening', 'Opening balance', {
        type: 'number',
        value: form.opening,
        onChange: on('opening'),
        placeholder: '0',
        hint: isSupplier ? 'Already payable to them' : 'Already owed by them',
      })
    );
  }

  return common;
}

/** The message to show instead of saving, or null when the form is good. */
export function validate(kind, form) {
  if (!String(form.name || '').trim()) {
    return `Enter the ${TITLES[kind][0]} name.`;
  }

  if (kind === 'crop') {
    if (!form.unit) return 'Choose the unit this crop is measured in.';
    if (Number(form.rate) < 0) return 'A rate cannot be negative.';
    return null;
  }

  if (kind === 'product') {
    if (!form.unit) return 'Choose the unit this product is sold in.';
    if (Number(form.pur) < 0 || Number(form.sale) < 0) return 'A rate cannot be negative.';
    // Not an error -- a loss leader is a real decision -- but worth saying so
    // it is not a typo that only shows up in the profit report.
    if (Number(form.sale) && Number(form.sale) < Number(form.pur)) {
      return 'The sale rate is below the purchase rate; every sale would lose money.';
    }
    return null;
  }

  if (kind === 'warehouse') return null;

  if (kind === 'unit') {
    if (!/^[A-Za-z][A-Za-z0-9 ]{0,15}$/.test(String(form.code || '').trim())) {
      return 'A unit code is letters and digits, like MT or Bag.';
    }
    if (form.base && !(Number(form.factor) > 0)) {
      return `Give what one ${form.code || 'unit'} is worth in ${form.base}.`;
    }
    if (Number(form.factor) < 0) return 'A conversion cannot be negative.';
    return null;
  }

  if (kind === 'account' || kind === 'category' || kind === 'method'
      || kind === 'productCategory' || kind === 'brand') {
    // The server holds the same rule; saying it here means the operator finds
    // out while typing rather than after saving.
    const allowed = kind === 'account' ? /^[A-Z0-9-]*$/ : /^[A-Z0-9_]*$/;
    if (form.code && !allowed.test(form.code)) {
      return kind === 'account'
        ? 'A code uses capitals, digits and dashes, like BANK-IBBL.'
        : 'A code uses capitals, digits and underscores, like OFFICE_UTILITY.';
    }
    return null;
  }

  if (kind === 'employee') {
    // A joining date in the future is a data-entry slip, not a plan.
    if (form.joined && form.joined > new Date().toISOString().slice(0, 10)) {
      return 'The joining date is in the future.';
    }
    return null;
  }

  if (kind !== 'company' && !String(form.mobile || '').trim()) {
    return 'Enter a mobile number — it is how the party is reached and matched.';
  }

  if (Number(form.limit) < 0) return 'A credit limit cannot be negative.';
  if (Number(form.days) < 0) return 'Credit days cannot be negative.';
  return null;
}

/** What goes to the server. */
export function payloadFor(kind, form) {
  const text = (v) => String(v ?? '').trim();
  const number = (v) => Number(v) || 0;

  if (kind === 'crop') {
    return { name: text(form.name), unit: form.unit, rate: number(form.rate) };
  }

  if (kind === 'warehouse') {
    return { name: text(form.name), district: text(form.district) };
  }

  if (kind === 'account') {
    return {
      // Omitted rather than empty, so the server allocates one.
      code: text(form.code) || undefined,
      name: text(form.name),
      type: form.type,
      opening: number(form.opening),
    };
  }

  if (kind === 'category' || kind === 'productCategory' || kind === 'brand') {
    return { code: text(form.code) || undefined, name: text(form.name) };
  }

  if (kind === 'method') {
    return {
      code: text(form.code) || undefined,
      name: text(form.name),
      account: text(form.account),
    };
  }

  if (kind === 'unit') {
    return {
      code: text(form.code),
      name: text(form.name),
      base: text(form.base),
      // A base unit is worth one of itself; anything else states its fraction.
      factor: form.base ? number(form.factor) : 1,
    };
  }

  if (kind === 'employee') {
    return {
      name: text(form.name),
      designation: text(form.designation),
      department: text(form.department),
      mobile: text(form.mobile),
      // Omitted rather than sent empty: the column is nullable and the schema
      // only accepts a real date.
      joined: form.joined || undefined,
    };
  }

  if (kind === 'product') {
    return {
      name: text(form.name),
      cat: text(form.cat),
      brand: text(form.brand),
      unit: form.unit,
      pur: number(form.pur),
      sale: number(form.sale),
      min: number(form.min),
    };
  }

  if (kind === 'company') {
    return {
      name: text(form.name),
      role: form.role,
      person: text(form.person),
      mobile: text(form.mobile),
      district: text(form.district),
      limit: number(form.limit),
      days: number(form.days),
    };
  }

  if (kind === 'supplier') {
    return {
      name: text(form.name),
      bn: text(form.bn),
      type: form.type,
      mobile: text(form.mobile),
      district: text(form.district),
      upazila: text(form.upazila),
      bank: text(form.bank),
      opening: number(form.opening),
    };
  }

  return {
    name: text(form.name),
    bn: text(form.bn),
    type: form.type,
    person: text(form.person),
    mobile: text(form.mobile),
    district: text(form.district),
    upazila: text(form.upazila),
    limit: number(form.limit),
    days: number(form.days),
    opening: number(form.opening),
  };
}

/** Build the modal model for the master form. */
export function buildMasterModal(kind, state, data, handlers) {
  const { form, row, error, busy } = state;
  const noun = TITLES[kind][0];
  const editing = !!row;

  return formModal({
    open: true,
    title: editing ? `Edit ${noun}` : `New ${noun}`,
    subtitle: editing ? `${row.code} · ${row.name}` : TITLES[kind][1],
    fields: fieldsFor(kind, form, data, handlers.onField, row),
    error,
    busy,
    submitLabel: editing ? 'Save changes' : `Add ${noun}`,
    note: editing
      ? 'Changes apply from now on; posted documents keep the details they were posted with'
      : 'The code is allocated by the server when the record is saved',
    onSubmit: handlers.onSubmit,
    onCancel: handlers.onCancel,
  });
}
